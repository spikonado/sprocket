//! Walks a `.kicad_pcb` file one top-level item at a time and draws each item into a scene.

use std::collections::HashMap;

use anyhow::Result;

use crate::geometry::{Arc, Point, Transform, point};
use crate::scene::{HOLES_LAYER, ItemInfo, ItemKind, Part, Pen, Scene, inner_copper_number};
use crate::sexpr::{Expr, for_each_item};

mod flash;
mod graphics;
mod pad;
mod stroke;
mod textbox;

use flash::{Capsule, FlashRule, Flashing};

/// The first file version that stores footprint zones in the footprint's frame.
const FIRST_FP_AFFINE_TRANSFORM: i64 = 20260616;
/// The first file version whose bold text thickness excludes KiCad's bold multiplier.
const FIRST_BOLD_MULTIPLIER: i64 = 20260826;
/// Polygons without a `(fill)` token are filled up to this version.
const LAST_IMPLICIT_POLY_FILL: i64 = 20210722;
/// Up to this version, a local solder mask or paste margin of 0 means "inherit".
const LAST_ZERO_MARGIN_INHERITS: i64 = 20240201;
/// KiCad paints hole walls 1.5 times its default 0.035 mm plating thickness.
const HOLE_WALL: f64 = 1.5 * 0.035;

pub fn scene(src: &str) -> Result<Vec<u8>> {
    let mut board = Board {
        scene: Scene::new(),
        version: 0,
        net_names: HashMap::new(),
        vars: HashMap::new(),
        copper: Vec::new(),
        setup: Setup::default(),
        flashing: Flashing::default(),
    };
    for_each_item(src, "kicad_pcb", |item| {
        board.item(item);
        Ok(())
    })?;
    board.flash();
    Ok(board.scene.encode())
}

/// Text variables a footprint adds, such as `REFERENCE` and its fields.
type Fields = HashMap<String, String>;

/// Solder mask and paste margins, which footprints and pads override in turn.
#[derive(Clone, Copy, Debug, Default)]
struct Margins {
    mask: f64,
    paste: f64,
    paste_ratio: f64,
}

impl Margins {
    fn overridden_by(self, item: Expr, version: i64) -> Margins {
        let local = |names: &[&str], inherited: f64| {
            names
                .iter()
                .find_map(|name| item.number_value(name))
                .filter(|&value| value != 0.0 || version > LAST_ZERO_MARGIN_INHERITS)
                .unwrap_or(inherited)
        };
        Margins {
            mask: local(&["solder_mask_margin"], self.mask),
            paste: local(&["solder_paste_margin"], self.paste),
            paste_ratio: local(
                &["solder_paste_margin_ratio", "solder_paste_ratio"],
                self.paste_ratio,
            ),
        }
    }
}

/// The board-wide defaults from `(setup …)`.
#[derive(Debug)]
struct Setup {
    margins: Margins,
    /// Whether vias without their own `tenting` are covered by mask on the front and back.
    tented: (bool, bool),
}

impl Default for Setup {
    fn default() -> Setup {
        Setup {
            margins: Margins::default(),
            tented: (true, true),
        }
    }
}

struct Board {
    scene: Scene,
    version: i64,
    net_names: HashMap<i64, String>,
    vars: HashMap<String, String>,
    /// Copper layers from top to bottom.
    copper: Vec<String>,
    setup: Setup,
    flashing: Flashing,
}

impl Board {
    fn item(&mut self, item: Expr) {
        let Some(head) = item.head() else {
            return;
        };
        match head {
            "version" => self.version = item.number_arg(0).map_or(0, |version| version as i64),
            "layers" => self.layers(item),
            "setup" => self.setup(item),
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
            "gr_text_box" => self.textbox(item, &Transform::IDENTITY, None),
            "table" => self.table(item, &Transform::IDENTITY, None),
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

    fn setup(&mut self, setup: Expr) {
        for entry in setup.args() {
            let number = || entry.number_arg(0).unwrap_or(0.0);
            match entry.head() {
                Some("pad_to_mask_clearance") => self.setup.margins.mask = number(),
                Some("pad_to_paste_clearance") => self.setup.margins.paste = number(),
                Some("pad_to_paste_clearance_ratio") => self.setup.margins.paste_ratio = number(),
                Some("tenting") => {
                    let (front, back) = front_back(entry);
                    self.setup.tented = (front.unwrap_or(false), back.unwrap_or(false));
                }
                // Boards before KiCad 9 kept via tenting in the plot settings.
                Some("pcbplotparams") if entry.child("viasonmask").is_some() => {
                    let tented = !entry.flag("viasonmask");
                    self.setup.tented = (tented, tented);
                }
                _ => {}
            }
        }
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

    fn copper_index(&self, layer: &str) -> Option<usize> {
        self.copper.iter().position(|name| name == layer)
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
        let margins = self.setup.margins.overridden_by(footprint, self.version);
        for child in footprint.args() {
            match child.head() {
                Some("property") | Some("fp_text") => {
                    if let Some(text) = child.text_arg(1) {
                        self.text(id, child, &text, &frame, Some(&fields));
                    }
                }
                Some("pad") => self.pad(child, id, &frame, margins),
                Some("fp_text_box") => self.textbox(child, &frame, Some((id, &fields))),
                Some("table") => self.table(child, &frame, Some((id, &fields))),
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
                    {
                        self.masked_shape(id, child, shape, &frame);
                    }
                }
                None => {}
            }
        }
    }

    fn track(&mut self, track: Expr, kind: ItemKind) {
        let Some((layer, mask)) = item_layers(track) else {
            return;
        };
        let width = track.number_value("width").unwrap_or(0.0);
        let net = self.net(track);
        let id = self.scene.add_item(
            kind,
            ItemInfo {
                layer: Some(layer.clone()),
                net,
                ..ItemInfo::default()
            },
        );
        let (Some(start), Some(end)) = (child_point(track, "start"), child_point(track, "end"))
        else {
            return;
        };
        let points = match child_point(track, "mid").and_then(|mid| Arc::through(start, mid, end)) {
            Some(arc) => arc.points(),
            None => vec![start, end],
        };
        if let Some(copper) = self.copper_index(&layer) {
            self.index_track(copper, net.unwrap_or(0), &points, width);
        }
        let pen = self.pen(id, &layer, Part::Main);
        self.scene.polyline(pen, &points, width, false);
        if let Some(mask) = mask {
            let margin = self.mask_margin(track);
            let pen = self.pen(id, &mask, Part::Main);
            self.scene
                .polyline(pen, &points, width + 2.0 * margin, false);
        }
    }

    /// The mask opening margin of a track or shape on outer copper.
    fn mask_margin(&self, item: Expr) -> f64 {
        item.number_value("solder_mask_margin")
            .unwrap_or(self.setup.margins.mask)
    }

    fn via(&mut self, via: Expr) {
        if self.copper.is_empty() {
            return;
        }
        let center = child_point(via, "at").unwrap_or_default();
        let layers: Vec<String> = via
            .child("layers")
            .into_iter()
            .flat_map(Expr::args)
            .filter_map(Expr::text)
            .map(Into::into)
            .collect();
        let span = |name: Option<&String>, default: usize| {
            name.and_then(|name| self.copper_index(name))
                .unwrap_or(default)
        };
        let last = self.copper.len().saturating_sub(1);
        let (a, b) = (span(layers.first(), 0), span(layers.get(1), last));
        let ends = (a.min(b), a.max(b));
        let net = self.net(via);
        let id = self.scene.add_item(
            ItemKind::Via,
            ItemInfo {
                layer: self.copper.get(ends.0).cloned(),
                net,
                position: Some([center.x, center.y, 0.0]),
                ..ItemInfo::default()
            },
        );
        let drill = via.number_value("drill").unwrap_or(0.0);
        let hole = Capsule {
            a: center,
            b: center,
            radius: drill / 2.0,
        };
        let rule = FlashRule::new(via, ends, net.unwrap_or(0), hole);
        let size = via.number_value("size").unwrap_or(0.0);
        let padstack = via.child("padstack");
        let diameter = |layer: &str| {
            padstack_layer(padstack, layer)
                .and_then(|entry| entry.number_value("size"))
                .unwrap_or(size)
        };
        for copper in ends.0..=ends.1.min(last) {
            let layer = self.copper[copper].clone();
            if let Some(pen) = self.flash_pen(id, &layer, copper, &rule) {
                self.scene.circle(pen, center, diameter(&layer) / 2.0, 0.0);
            }
        }
        let tenting = via.child("tenting").map(front_back).unwrap_or_default();
        for (end, tented, default, copper, mask) in [
            (0, tenting.0, self.setup.tented.0, "F.Cu", "F.Mask"),
            (last, tenting.1, self.setup.tented.1, "B.Cu", "B.Mask"),
        ] {
            if (end == ends.0 || end == ends.1) && !tented.unwrap_or(default) {
                let pen = self.pen(id, mask, Part::Main);
                let radius = diameter(copper) / 2.0 + self.setup.margins.mask;
                self.scene.circle(pen, center, radius, 0.0);
            }
        }
        if drill > 0.0 {
            let radius = size / 2.0;
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

/// An item's `(layer …)`, or the copper and mask layers of `(layers "F.Cu" "F.Mask")`, which
/// KiCad writes for tracks and shapes with a mask opening.
fn item_layers(item: Expr) -> Option<(String, Option<String>)> {
    if let Some(layer) = item.value("layer") {
        return Some((layer.into_owned(), None));
    }
    let (mut layer, mut mask) = (None, None);
    for name in item.child("layers")?.args().filter_map(Expr::text) {
        if name.ends_with(".Mask") {
            mask = Some(name.into_owned());
        } else {
            layer = Some(name.into_owned());
        }
    }
    Some((layer?, mask))
}

/// The `(layer …)` entry of a pad or via `(padstack …)` that sets the shape on `layer`, after
/// KiCad's `PADSTACK::CopperLayer`. `None` means the item's own front copper properties.
fn padstack_layer<'t, 'a>(padstack: Option<Expr<'t, 'a>>, layer: &str) -> Option<Expr<'t, 'a>> {
    let padstack = padstack?;
    let front = layer.starts_with("F.");
    let back = layer.starts_with("B.");
    let key = match padstack.value("mode").as_deref() {
        Some("front_inner_back" | "custom") if front => "F.Cu",
        Some("front_inner_back") if back => "B.Cu",
        Some("front_inner_back") if !front && layer.ends_with(".Cu") => "Inner",
        Some("custom") if back => "B.Cu",
        Some("custom") if !front && layer.ends_with(".Cu") => layer,
        _ => return None,
    };
    padstack
        .children_named("layer")
        .find(|entry| entry.text_arg(0).as_deref() == Some(key))
}

/// Reads `(tenting front back)` or `(tenting (front yes) (back no))`.
fn front_back(sides: Expr) -> (Option<bool>, Option<bool>) {
    let mut out = (None, None);
    for side in sides.args() {
        let value = || match side.arg(0).and_then(Expr::atom) {
            Some("yes" | "true") => Some(true),
            Some("no" | "false") => Some(false),
            _ => None,
        };
        match (side.atom(), side.head()) {
            (Some("front"), _) => out.0 = Some(true),
            (Some("back"), _) => out.1 = Some(true),
            (Some("none"), _) => out = (None, None),
            (_, Some("front")) => out.0 = value(),
            (_, Some("back")) => out.1 = value(),
            _ => {}
        }
    }
    out
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
mod test_support;
#[cfg(test)]
mod tests;
