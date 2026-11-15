//! Footprint pads, their drill holes and their number and net name labels.

use super::flash::{Capsule, FlashRule};
use super::{Board, HOLE_WALL, Margins, child_point, padstack_layer, unescape_net, xy};
use crate::geometry::{Arc, Point, Transform, inset_convex, point};
use crate::scene::{HOLES_LAYER, ItemInfo, ItemKind, Part, Pen, Scene};
use crate::sexpr::Expr;
use crate::text::{HAlign, TextStyle, VAlign, stroke_text};

/// KiCad's `PCB_RENDER_SETTINGS::MAX_FONT_SIZE`.
const MAX_LABEL_SIZE: f64 = 10.0;

/// A pad's shape on one layer, from the pad itself or its `(padstack …)`.
#[derive(Clone, Copy)]
struct PadShape<'t, 'a> {
    shape: &'a str,
    size: Point,
    /// Where the shape sits relative to the drill.
    offset: Point,
    delta: Point,
    radius_ratio: f64,
    chamfer_ratio: f64,
    chamfers: Option<Expr<'t, 'a>>,
    anchor: &'a str,
    primitives: Option<Expr<'t, 'a>>,
}

impl<'t, 'a> PadShape<'t, 'a> {
    fn read(pad: Expr<'t, 'a>) -> PadShape<'t, 'a> {
        PadShape {
            shape: pad.arg(2).and_then(Expr::atom).unwrap_or("circle"),
            size: Point::default(),
            offset: pad
                .child("drill")
                .and_then(|drill| child_point(drill, "offset"))
                .unwrap_or_default(),
            delta: Point::default(),
            radius_ratio: 0.0,
            chamfer_ratio: 0.0,
            chamfers: None,
            anchor: "circle",
            primitives: None,
        }
        .with(pad)
    }

    fn with(mut self, entry: Expr<'t, 'a>) -> PadShape<'t, 'a> {
        for field in entry.args() {
            match field.head() {
                Some("shape") => {
                    if let Some(shape) = field.arg(0).and_then(Expr::atom) {
                        self.shape = shape;
                    }
                }
                Some("size") => self.size = xy(field).unwrap_or(self.size),
                Some("offset") => self.offset = xy(field).unwrap_or(self.offset),
                Some("rect_delta") => self.delta = xy(field).unwrap_or(self.delta),
                Some("roundrect_rratio") => self.radius_ratio = field.number_arg(0).unwrap_or(0.0),
                Some("chamfer_ratio") => self.chamfer_ratio = field.number_arg(0).unwrap_or(0.0),
                Some("chamfer") => self.chamfers = Some(field),
                Some("options") => {
                    self.anchor = match field.value("anchor").as_deref() {
                        Some("rect") => "rect",
                        _ => "circle",
                    }
                }
                Some("primitives") => self.primitives = Some(field),
                _ => {}
            }
        }
        self
    }

    /// The shape on `layer`. Padstack entries start from the pad's front copper shape with
    /// no offset or trapezoid delta, as KiCad's parser does.
    fn on(self, padstack: Option<Expr<'t, 'a>>, layer: &str) -> PadShape<'t, 'a> {
        match padstack_layer(padstack, layer) {
            Some(entry) => PadShape {
                offset: Point::default(),
                delta: Point::default(),
                ..self
            }
            .with(entry),
            None => self,
        }
    }

    fn corner_radius(&self) -> f64 {
        let short = self.size.x.min(self.size.y);
        if self.shape == "roundrect" {
            (self.radius_ratio * short).min(short / 2.0)
        } else {
            0.0
        }
    }

    fn chamfer(&self) -> Option<(f64, Expr<'t, 'a>)> {
        let chamfer = self.chamfer_ratio * self.size.x.min(self.size.y);
        self.chamfers
            .filter(|_| chamfer > 0.0)
            .map(|corners| (chamfer, corners))
    }
}

impl Board {
    pub(super) fn pad(&mut self, pad: Expr, footprint: u32, frame: &Transform, margins: Margins) {
        let at = pad.child("at");
        let degrees = at.and_then(|at| at.number_arg(2)).unwrap_or(0.0);
        let pad_frame = frame.child(at.and_then(xy).unwrap_or_default(), degrees);
        let center = pad_frame.origin();
        let layers = self.expand_layers(pad.child("layers"));
        let net = self.net(pad);
        let id = self.scene.add_item(
            ItemKind::Pad,
            ItemInfo {
                parent: Some(footprint),
                layer: layers.first().cloned(),
                net,
                number: pad.text_arg(0).map(Into::into),
                position: Some([center.x, center.y, degrees]),
                ..ItemInfo::default()
            },
        );
        let kind = pad.arg(1).and_then(Expr::atom).unwrap_or("smd");
        let front = PadShape::read(pad);
        let padstack = pad.child("padstack");
        let margins = margins.overridden_by(pad, self.version);
        let has_copper = layers.iter().any(|layer| layer.ends_with(".Cu"));
        let drill = pad
            .child("drill")
            .and_then(|drill| Drill::read(drill, &pad_frame));
        let last = self.copper.len().saturating_sub(1);
        let rule = drill
            .filter(|_| kind == "thru_hole")
            .map(|drill| FlashRule::new(pad, (0, last), net.unwrap_or(0), drill.capsule));
        for layer in &layers {
            let is_copper = layer.ends_with(".Cu");
            let copper = if is_copper {
                layer.as_str()
            } else if layer.starts_with("B.") {
                "B.Cu"
            } else {
                "F.Cu"
            };
            let shape = front.on(padstack, copper);
            if kind == "np_thru_hole"
                && is_copper
                && drill.is_some_and(|drill| drill.covers(&shape))
            {
                continue;
            }
            let margin = match layer.rsplit_once('.').map(|(_, kind)| kind) {
                Some("Mask") if has_copper => {
                    let mask = margins.mask.max(-shape.size.x.min(shape.size.y) / 2.0);
                    point(mask, mask)
                }
                Some("Paste") if has_copper => {
                    let paste =
                        shape.size * margins.paste_ratio + point(margins.paste, margins.paste);
                    if shape.shape == "custom" {
                        paste
                    } else {
                        point(
                            paste.x.max(-shape.size.x / 2.0),
                            paste.y.max(-shape.size.y / 2.0),
                        )
                    }
                }
                _ => Point::default(),
            };
            let pen = match (&rule, self.copper_index(copper)) {
                (Some(rule), Some(index)) if is_copper => self.flash_pen(id, layer, index, rule),
                _ => Some(self.pen(id, layer, Part::Main)),
            };
            if let Some(pen) = pen {
                let shape_frame = pad_frame.child(shape.offset, degrees);
                self.pad_shape(pen, &shape, &shape_frame, margin);
            }
        }
        let board_size = point(frame.length(front.size.x), frame.length(front.size.y));
        self.labels(id, pad, front.shape, board_size, net, &layers);
        if let Some(drill) = drill {
            let plated = kind != "np_thru_hole";
            self.drill(id, &drill, plated.then_some(board_size));
        }
        self.scene.merge_bounds(footprint, id);
    }

    /// Writes the pad number and net name over the pad as KiCad does, after
    /// `PCB_PAINTER::draw( const PAD* )`, on each outer copper side the pad has.
    fn labels(
        &mut self,
        id: u32,
        pad: Expr,
        shape: &str,
        pad_size: Point,
        net: Option<u32>,
        layers: &[String],
    ) {
        let sides: Vec<(&str, bool)> = [("F.Cu", false), ("B.Cu", true)]
            .into_iter()
            .filter(|(side, _)| layers.iter().any(|layer| layer == side))
            .collect();
        let bounds = self.scene.bounds(id);
        if sides.is_empty() || bounds.is_empty() {
            return;
        }
        let number = unescape_net(&pad.text_arg(0).unwrap_or_default());
        let net_name = net.map_or("", |net| self.scene.net_name(net));
        let pin_type = pad.value("pintype").unwrap_or_default();
        let unconnected = net_name.starts_with("unconnected-(");
        let name = if unconnected && pin_type.contains("no_connect") {
            "x"
        } else if unconnected && pin_type == "free" {
            "*"
        } else {
            net_name.rsplit('/').next().unwrap_or_default()
        }
        .to_owned();
        if name.is_empty() && number.is_empty() {
            return;
        }

        let center = (bounds.min + bounds.max) * 0.5;
        let mut extent = bounds.max - bounds.min;
        let limit = pad_size.x.min(pad_size.y) * 1.1;
        if shape != "custom" && extent.x > limit && extent.y > limit {
            extent = point(limit, limit);
        }
        let vertical = extent.x < extent.y * 0.95;
        let (mut size, along) = if vertical {
            (extent.x, extent.y)
        } else {
            (extent.y, extent.x)
        };
        size = size.min(MAX_LABEL_SIZE);
        let (mut name_offset, mut number_offset) = (0.0, 0.0);
        if !name.is_empty() && !number.is_empty() {
            size /= 2.5;
            name_offset = size / 1.4;
            number_offset = size / 1.7;
        }

        let mut lines = Vec::with_capacity(2);
        if !name.is_empty() {
            let chars = name.chars().count() + 1;
            let mut height = (1.5 * along / chars.max(5) as f64).min(size) * 0.85;
            if matches!(shape, "circle" | "oval") {
                height *= 0.9;
            }
            lines.push((name.as_str(), height, (height * 1.4).min(name_offset)));
        }
        if !number.is_empty() {
            let chars = number.chars().count();
            let height = (1.5 * along / chars.max(3) as f64).min(size) * 0.85;
            lines.push((number.as_str(), height, -number_offset));
        }

        for (layer, mirrored) in sides {
            let pen = self.pen(id, layer, Part::Labels);
            for &(text, height, offset) in &lines {
                let glyph = point(height * 0.9, height);
                let style = TextStyle {
                    size: glyph,
                    pen_width: glyph.x / 6.0,
                    degrees: if vertical { 90.0 } else { 0.0 },
                    mirrored,
                    italic: false,
                    h_align: HAlign::Center,
                    v_align: VAlign::Center,
                    line_spacing: 1.0,
                };
                let shift = if vertical {
                    point(offset, 0.0)
                } else {
                    point(0.0, offset)
                };
                for stroke in stroke_text(text, center + shift, &style) {
                    self.scene.polyline(pen, &stroke, style.pen_width, false);
                }
            }
        }
    }

    /// Draws a pad shape grown by `margin` on each side, as KiCad's `PlotStandardLayer` does
    /// for mask and paste layers.
    fn pad_shape(&mut self, pen: Pen, shape: &PadShape, frame: &Transform, margin: Point) {
        let mut shape = *shape;
        let mut radius = shape.corner_radius();
        let local = margin * (1.0 / frame.length(1.0));
        let equal = local.x == local.y;
        let mut grow = 0.0;
        match shape.shape {
            "custom" => {}
            "trapezoid" => grow = local.x,
            "roundrect" if shape.chamfer().is_some() && equal && local.x > 0.0 => {
                grow = local.x;
            }
            "circle" => shape.size = shape.size + point(local.x, local.x) * 2.0,
            _ => {
                shape.size = shape.size + local * 2.0;
                radius = match shape.shape {
                    "rect" => local.x.max(0.0),
                    "roundrect" if equal && shape.chamfer().is_none() => {
                        (radius + local.x).max(0.0)
                    }
                    _ => shape.corner_radius(),
                };
            }
        }
        if shape.shape != "custom" && (shape.size.x <= 0.0 || shape.size.y <= 0.0) {
            return;
        }
        let half = shape.size * 0.5;
        match shape.shape {
            "circle" => self
                .scene
                .circle(pen, frame.origin(), frame.length(half.x), 0.0),
            "oval" => {
                let width = half.x.min(half.y) * 2.0;
                let along = point(half.x - width / 2.0, half.y - width / 2.0);
                self.scene.segment(
                    pen,
                    frame.apply(-along),
                    frame.apply(along),
                    frame.length(width),
                );
            }
            "rect" | "roundrect" => {
                if let Some((chamfer, corners)) = shape.chamfer() {
                    let outline: Vec<Point> =
                        chamfered_rect(half, chamfer, radius, |corner| corners.has_flag(corner))
                            .into_iter()
                            .map(|p| frame.apply(p))
                            .collect();
                    self.scene.polygon(pen, &outline, &[]);
                    self.scene
                        .polyline(pen, &outline, frame.length(2.0 * grow), true);
                } else {
                    self.rounded(pen, &rect(half), radius, grow, frame);
                }
            }
            "trapezoid" => {
                let delta = shape.delta * 0.5;
                let (hx, hy) = (half.x, half.y);
                let corners = [
                    point(-hx - delta.y, hy + delta.x),
                    point(hx + delta.y, hy - delta.x),
                    point(hx - delta.y, -hy + delta.x),
                    point(-hx + delta.y, -hy - delta.x),
                ];
                self.rounded(pen, &corners, 0.0, grow, frame);
            }
            "custom" => {
                if margin.x != 0.0 {
                    let real = std::mem::replace(&mut self.scene, Scene::new());
                    let temporary = Pen {
                        item: self.scene.add_item(ItemKind::Pad, ItemInfo::default()),
                        layer: self.scene.layer("F.Cu", Part::Main),
                    };
                    self.pad_shape(temporary, &shape, frame, Point::default());
                    let outline = std::mem::replace(&mut self.scene, real);
                    for polygon in outline.offset_polygons(margin.x) {
                        self.scene.polygon(pen, &polygon[0], &polygon[1..]);
                    }
                    return;
                }
                let anchor = PadShape {
                    shape: shape.anchor,
                    ..shape
                };
                self.pad_shape(pen, &anchor, frame, Point::default());
                for primitive in shape.primitives.into_iter().flat_map(Expr::args) {
                    let Some(name) = primitive.head().and_then(|head| head.strip_prefix("gr_"))
                    else {
                        continue;
                    };
                    self.shape(pen, primitive, name, frame, true, 0.0);
                }
            }
            _ => {}
        }
    }

    /// Fills a convex outline with its corners rounded by `radius`, grown by `grow` on each
    /// side, or shrunk with sharp corners when `grow` eats the rounding.
    fn rounded(&mut self, pen: Pen, outline: &[Point], radius: f64, grow: f64, frame: &Transform) {
        let reach = radius + grow;
        let inset = if reach >= 0.0 { radius } else { -grow };
        let inner: Vec<Point> = inset_convex(outline, inset)
            .into_iter()
            .map(|p| frame.apply(p))
            .collect();
        self.scene.polygon(pen, &inner, &[]);
        if reach > 0.0 {
            self.scene
                .polyline(pen, &inner, frame.length(reach * 2.0), true);
        }
    }

    /// Plated holes, given their pad's size, get a wall drawn around them as in KiCad.
    fn drill(&mut self, id: u32, drill: &Drill, plated_pad_size: Option<Point>) {
        let Capsule { a, b, radius } = drill.capsule;
        let mut hole = |part: Part, width: f64| {
            let pen = self.pen(id, HOLES_LAYER, part);
            if a == b {
                self.scene.circle(pen, a, width / 2.0, 0.0);
            } else {
                self.scene.segment(pen, a, b, width);
            }
        };
        let thickness = radius * 2.0;
        match plated_pad_size {
            Some(size) => {
                let wall = HOLE_WALL.min(size.x / 2.0).min(size.y / 2.0);
                hole(Part::PadWalls, thickness + 2.0 * wall);
                hole(Part::PadHoles, thickness);
            }
            None => hole(Part::Npth, thickness),
        }
    }
}

/// A pad's drill in board coordinates, and its size in the pad's frame.
#[derive(Clone, Copy)]
struct Drill {
    capsule: Capsule,
    oval: bool,
    size: Point,
}

impl Drill {
    fn read(drill: Expr, frame: &Transform) -> Option<Drill> {
        let numbers: Vec<f64> = drill.args().filter_map(Expr::number).collect();
        let oval = drill.has_flag("oval");
        let size = match (oval, numbers.as_slice()) {
            (true, &[width, height, ..]) => point(width, height),
            (_, &[diameter, ..]) => point(diameter, diameter),
            _ => return None,
        };
        let thickness = size.x.min(size.y);
        let along = frame.apply_vector(point(
            (size.x - thickness) / 2.0,
            (size.y - thickness) / 2.0,
        ));
        let center = frame.origin();
        Some(Drill {
            capsule: Capsule {
                a: center - along,
                b: center + along,
                radius: frame.length(thickness) / 2.0,
            },
            oval,
            size,
        })
    }

    /// Whether an unplated hole leaves no copper of `shape`, after KiCad's `PAD::FlashLayer`.
    fn covers(&self, shape: &PadShape) -> bool {
        let centered = shape.offset == Point::default();
        match (shape.shape, self.oval) {
            ("circle", false) => centered && self.size.x >= shape.size.x,
            ("oval", true) => {
                centered && self.size.x >= shape.size.x && self.size.y >= shape.size.y
            }
            _ => false,
        }
    }
}

fn rect(half: Point) -> [Point; 4] {
    [
        point(-half.x, -half.y),
        point(half.x, -half.y),
        point(half.x, half.y),
        point(-half.x, half.y),
    ]
}

fn chamfered_rect(
    half: Point,
    chamfer: f64,
    radius: f64,
    cut: impl Fn(&str) -> bool,
) -> Vec<Point> {
    let (hx, hy, c) = (half.x, half.y, chamfer);
    let mut outline = Vec::with_capacity(8);
    let mut corner = |name: &str, square: Point, before: Point, after: Point| {
        if cut(name) {
            outline.extend([before, after]);
        } else if radius > 0.0 {
            let incoming = (before - square).resized(radius);
            let outgoing = (after - square).resized(radius);
            let center = square + incoming + outgoing;
            outline.extend(Arc::from_center(center, square + incoming, 90.0).points());
        } else {
            outline.push(square);
        }
    };
    corner(
        "top_left",
        point(-hx, -hy),
        point(-hx, -hy + c),
        point(-hx + c, -hy),
    );
    corner(
        "top_right",
        point(hx, -hy),
        point(hx - c, -hy),
        point(hx, -hy + c),
    );
    corner(
        "bottom_right",
        point(hx, hy),
        point(hx, hy - c),
        point(hx - c, hy),
    );
    corner(
        "bottom_left",
        point(-hx, hy),
        point(-hx + c, hy),
        point(-hx, hy - c),
    );
    outline
}
