//! Walks a `.kicad_pcb` file one top-level item at a time and draws each item into a scene.

use std::collections::HashMap;

use anyhow::Result;

use crate::geometry::{Arc, Point, Transform, point};
use crate::scene::{HOLES_LAYER, ItemInfo, ItemKind, Part, Pen, Scene, inner_copper_number};
use crate::sexpr::{Expr, for_each_item};

mod graphics;
mod pad;

/// The first file version that stores footprint zones in the footprint's frame.
const FIRST_FP_AFFINE_TRANSFORM: i64 = 20260616;
/// The first file version whose bold text thickness excludes KiCad's bold multiplier.
const FIRST_BOLD_MULTIPLIER: i64 = 20260826;
/// Polygons without a `(fill)` token are filled up to this version.
const LAST_IMPLICIT_POLY_FILL: i64 = 20210722;
/// KiCad paints hole walls 1.5 times its default 0.035 mm plating thickness.
const HOLE_WALL: f64 = 1.5 * 0.035;

pub fn scene(src: &str) -> Result<Vec<u8>> {
    let mut board = Board {
        scene: Scene::new(),
        version: 0,
        net_names: HashMap::new(),
        vars: HashMap::new(),
        copper: Vec::new(),
    };
    for_each_item(src, "kicad_pcb", |item| {
        board.item(item);
        Ok(())
    })?;
    Ok(board.scene.encode())
}

/// Text variables a footprint adds, such as `REFERENCE` and its fields.
type Fields = HashMap<String, String>;

struct Board {
    scene: Scene,
    version: i64,
    net_names: HashMap<i64, String>,
    vars: HashMap<String, String>,
    /// Copper layers from top to bottom.
    copper: Vec<String>,
}

impl Board {
    fn item(&mut self, item: Expr) {
        let Some(head) = item.head() else {
            return;
        };
        match head {
            "version" => self.version = item.number_arg(0).map_or(0, |version| version as i64),
            "layers" => self.layers(item),
            "net" => {
                if let (Some(number), Some(name)) = (item.number_arg(0), item.text_arg(1)) {
                    self.net_names.insert(number as i64, unescape_net(&name));
                }
            }
            "title_block" => self.title_block(item),
            "property" => {
                if let (Some(key), Some(value)) = (item.text_arg(0), item.text_arg(1)) {
                    self.vars.insert(key.into_owned(), value.into_owned());
                }
            }
            "footprint" | "module" => self.footprint(item),
            "segment" => self.track(item, ItemKind::Track),
            "arc" => self.track(item, ItemKind::Arc),
            "via" => self.via(item),
            "zone" => {
                self.zone(item, None, &Transform::IDENTITY);
            }
            "gr_text" => self.board_text(item),
            "dimension" => self.dimension(item, None),
            _ => {
                if let Some(shape) = head
                    .strip_prefix("gr_")
                    .filter(|shape| graphics::is_shape(shape))
                {
                    self.board_shape(item, shape);
                }
            }
        }
    }

    fn layers(&mut self, layers: Expr) {
        for layer in layers.args() {
            let Some(name) = layer.text_arg(0) else {
                continue;
            };
            if let Some(user_name) = layer.text_arg(2) {
                self.scene.set_user_name(&name, &user_name);
            }
            if name.ends_with(".Cu") {
                self.copper.push(name.into_owned());
            }
        }
        self.copper.sort_by_key(|name| copper_rank(name));
    }

    fn title_block(&mut self, block: Expr) {
        for entry in block.args() {
            let (key, value) = match entry.head() {
                Some("title") => ("TITLE".to_owned(), entry.text_arg(0)),
                Some("date") => ("ISSUE_DATE".to_owned(), entry.text_arg(0)),
                Some("rev") => ("REVISION".to_owned(), entry.text_arg(0)),
                Some("company") => ("COMPANY".to_owned(), entry.text_arg(0)),
                Some("comment") => match entry.number_arg(0) {
                    Some(number) => (format!("COMMENT{number}"), entry.text_arg(1)),
                    None => continue,
                },
                _ => continue,
            };
            if let Some(value) = value {
                self.vars.insert(key, value.into_owned());
            }
        }
    }

    /// Reads `(net N "name")`, `(net N)` or `(net "name")`.
    fn net(&mut self, item: Expr) -> Option<u32> {
        let net = item.child("net")?;
        let first = net.arg(0)?;
        let name = match first.number() {
            Some(number) => match net.text_arg(1) {
                Some(name) => unescape_net(&name),
                None => self
                    .net_names
                    .get(&(number as i64))
                    .cloned()
                    .unwrap_or_default(),
            },
            None => unescape_net(&first.text()?),
        };
        Some(self.scene.net(&name))
    }

    /// Expands `*.Cu`, `F&B.Cu` and `*.Mask` style layer sets into layer names.
    fn expand_layers(&self, layers: Option<Expr>) -> Vec<String> {
        let mut out = Vec::new();
        for name in layers
            .into_iter()
            .flat_map(Expr::args)
            .filter_map(Expr::text)
        {
            if name == "*.Cu" {
                out.extend(self.copper.iter().cloned());
            } else if let Some(suffix) = name
                .strip_prefix("*.")
                .or_else(|| name.strip_prefix("F&B."))
            {
                out.push(format!("F.{suffix}"));
                out.push(format!("B.{suffix}"));
            } else {
                out.push(name.into_owned());
            }
        }
        out
    }

    fn pen(&mut self, item: u32, layer: &str, part: Part) -> Pen {
        Pen {
            item,
            layer: self.scene.layer(layer, part),
        }
    }

    fn footprint(&mut self, footprint: Expr) {
        let frame = footprint_transform(footprint);
        let link = footprint.text_arg(0).unwrap_or_default();
        let mut fields = Fields::new();
        let (library, name) = link.split_once(':').unwrap_or(("", &link));
        fields.insert("FOOTPRINT_LIBRARY".to_owned(), library.to_owned());
        fields.insert("FOOTPRINT_NAME".to_owned(), name.to_owned());
        for child in footprint.args() {
            let (key, value) = match child.head() {
                Some("property") => (child.text_arg(0), child.text_arg(1)),
                Some("fp_text") => (child.arg(0).and_then(Expr::text), child.text_arg(1)),
                _ => continue,
            };
            let (Some(key), Some(value)) = (key, value) else {
                continue;
            };
            let key = match &*key {
                "Reference" | "reference" => "REFERENCE".to_owned(),
                "Value" | "value" => "VALUE".to_owned(),
                _ => key.into_owned(),
            };
            fields.insert(key, value.into_owned());
        }

        let origin = frame.origin();
        let id = self.scene.add_item(
            ItemKind::Footprint,
            ItemInfo {
                layer: footprint.value("layer").map(Into::into),
                reference: fields.get("REFERENCE").cloned(),
                value: fields.get("VALUE").cloned(),
                footprint: Some(link.to_string()),
                position: Some([origin.x, origin.y, frame.degrees()]),
                ..ItemInfo::default()
            },
        );
        let zone_frame = if self.version < FIRST_FP_AFFINE_TRANSFORM {
            Transform::IDENTITY
        } else {
            frame
        };
        for child in footprint.args() {
            match child.head() {
                Some("property") | Some("fp_text") => {
                    if let Some(text) = child.text_arg(1) {
                        self.text(id, child, &text, &frame, Some(&fields));
                    }
                }
                Some("pad") => self.pad(child, id, &frame),
                // KiCad saves footprint dimensions in board coordinates.
                Some("dimension") => self.dimension(child, Some(id)),
                Some("zone") => {
                    if let Some(zone) = self.zone(child, Some(id), &zone_frame) {
                        self.scene.merge_bounds(id, zone);
                    }
                }
                Some(head) => {
                    if let Some(shape) = head
                        .strip_prefix("fp_")
                        .filter(|shape| graphics::is_shape(shape))
                        && let Some(layer) = child.value("layer")
                    {
                        let pen = self.pen(id, &layer, Part::Main);
                        self.shape(pen, child, shape, &frame, false);
                    }
                }
                None => {}
            }
        }
    }

    fn track(&mut self, track: Expr, kind: ItemKind) {
        let Some(layer) = track.value("layer") else {
            return;
        };
        let width = track.number_value("width").unwrap_or(0.0);
        let net = self.net(track);
        let id = self.scene.add_item(
            kind,
            ItemInfo {
                layer: Some(layer.to_string()),
                net,
                ..ItemInfo::default()
            },
        );
        let pen = self.pen(id, &layer, Part::Main);
        let (Some(start), Some(end)) = (child_point(track, "start"), child_point(track, "end"))
        else {
            return;
        };
        match child_point(track, "mid").and_then(|mid| Arc::through(start, mid, end)) {
            Some(arc) => self.scene.polyline(pen, &arc.points(), width, false),
            None => self.scene.segment(pen, start, end, width),
        }
    }

    fn via(&mut self, via: Expr) {
        let center = child_point(via, "at").unwrap_or_default();
        let layers: Vec<String> = via
            .child("layers")
            .into_iter()
            .flat_map(Expr::args)
            .filter_map(Expr::text)
            .map(Into::into)
            .collect();
        let span = |name: Option<&String>, default: usize| {
            name.and_then(|name| self.copper.iter().position(|layer| layer == name))
                .unwrap_or(default)
        };
        let last = self.copper.len().saturating_sub(1);
        let (a, b) = (span(layers.first(), 0), span(layers.get(1), last));
        let spanned = self
            .copper
            .get(a.min(b)..=a.max(b))
            .unwrap_or_default()
            .to_vec();
        let net = self.net(via);
        let id = self.scene.add_item(
            ItemKind::Via,
            ItemInfo {
                layer: spanned.first().cloned(),
                net,
                position: Some([center.x, center.y, 0.0]),
                ..ItemInfo::default()
            },
        );
        let radius = via.number_value("size").unwrap_or(0.0) / 2.0;
        for layer in &spanned {
            let pen = self.pen(id, layer, Part::Main);
            self.scene.circle(pen, center, radius, 0.0);
        }
        if let Some(drill) = via.number_value("drill") {
            let wall = self.pen(id, HOLES_LAYER, Part::ViaWalls);
            self.scene
                .circle(wall, center, (drill / 2.0 + HOLE_WALL).min(radius), 0.0);
            let hole = self.pen(id, HOLES_LAYER, Part::ViaHoles);
            self.scene.circle(hole, center, drill / 2.0, 0.0);
        }
    }

    /// Draws a zone's fills and returns its item, or `None` for keepouts.
    fn zone(&mut self, zone: Expr, parent: Option<u32>, frame: &Transform) -> Option<u32> {
        if zone.child("keepout").is_some() {
            return None;
        }
        let layers = self.expand_layers(zone.child("layers"));
        let layer = zone
            .value("layer")
            .map(Into::into)
            .or_else(|| layers.first().cloned());
        let net = match zone.value("net_name") {
            Some(name) => Some(self.scene.net(&unescape_net(&name))),
            None => self.net(zone),
        };
        let id = self.scene.add_item(
            ItemKind::Zone,
            ItemInfo {
                parent,
                layer,
                net,
                ..ItemInfo::default()
            },
        );
        if let Some(outline) = zone
            .child("polygon")
            .and_then(|polygon| polygon.child("pts"))
        {
            for p in points(outline) {
                self.scene.include(id, frame.apply(p));
            }
        }
        let outline_width = zone
            .flag("filled_areas_thickness")
            .then(|| zone.number_value("min_thickness"))
            .flatten()
            .map(|width| frame.length(width));
        for fill in zone.children_named("filled_polygon") {
            let Some(layer) = fill.value("layer") else {
                continue;
            };
            let pen = self.pen(id, &layer, Part::Zones);
            let mut rings = fill.children_named("pts").map(|pts| {
                points(pts)
                    .into_iter()
                    .map(|p| frame.apply(p))
                    .collect::<Vec<_>>()
            });
            let Some(outline) = rings.next() else {
                continue;
            };
            let holes: Vec<Vec<Point>> = rings.collect();
            self.scene.polygon(pen, &outline, &holes);
            if let Some(width) = outline_width {
                for ring in std::iter::once(&outline).chain(&holes) {
                    self.scene.polyline(pen, ring, width, true);
                }
            }
        }
        Some(id)
    }
}

fn footprint_transform(footprint: Expr) -> Transform {
    if let Some(transform) = footprint.child("transform") {
        return Transform::new(
            child_point(transform, "translate").unwrap_or_default(),
            transform.number_value("rotate").unwrap_or(0.0),
            child_point(transform, "scale").unwrap_or(point(1.0, 1.0)),
        );
    }
    let at = footprint.child("at");
    Transform::new(
        at.and_then(xy).unwrap_or_default(),
        at.and_then(|at| at.number_arg(2)).unwrap_or(0.0),
        point(1.0, 1.0),
    )
}

fn copper_rank(name: &str) -> u32 {
    match name {
        "F.Cu" => 0,
        "B.Cu" => u32::MAX,
        _ => inner_copper_number(name).unwrap_or(u32::MAX - 1),
    }
}

/// The first two numbers of a list, as in `(start 1 2)`.
fn xy(list: Expr) -> Option<Point> {
    Some(point(list.number_arg(0)?, list.number_arg(1)?))
}

fn child_point(item: Expr, name: &str) -> Option<Point> {
    xy(item.child(name)?)
}

/// The points of a `(pts …)` list, with `(arc …)` entries tessellated.
fn points(pts: Expr) -> Vec<Point> {
    let mut out = Vec::new();
    for entry in pts.args() {
        match entry.head() {
            Some("xy") => out.extend(xy(entry)),
            Some("arc") => {
                let (Some(start), Some(mid), Some(end)) = (
                    child_point(entry, "start"),
                    child_point(entry, "mid"),
                    child_point(entry, "end"),
                ) else {
                    continue;
                };
                match Arc::through(start, mid, end) {
                    Some(arc) => out.extend(arc.points()),
                    None => out.extend([start, end]),
                }
            }
            _ => {}
        }
    }
    out
}

/// Reverses KiCad's net name escapes such as `{slash}`.
fn unescape_net(name: &str) -> String {
    if !name.contains('{') {
        return name.to_owned();
    }
    const ESCAPES: [(&str, &str); 14] = [
        ("{slash}", "/"),
        ("{backslash}", "\\"),
        ("{lt}", "<"),
        ("{gt}", ">"),
        ("{colon}", ":"),
        ("{dblquote}", "\""),
        ("{quote}", "'"),
        ("{bar}", "|"),
        ("{comma}", ","),
        ("{space}", " "),
        ("{dollar}", "$"),
        ("{tab}", "\t"),
        ("{return}", "\n"),
        ("{brace}", "{"),
    ];
    let mut out = String::with_capacity(name.len());
    let mut rest = name;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        rest = &rest[open..];
        match ESCAPES.iter().find(|(escape, _)| rest.starts_with(escape)) {
            Some((escape, plain)) => {
                out.push_str(plain);
                rest = &rest[escape.len()..];
            }
            None => {
                out.push('{');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests;
