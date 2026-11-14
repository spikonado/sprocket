//! Footprint pads, their drill holes and their number and net name labels.

use super::{Board, HOLE_WALL, child_point, unescape_net, xy};
use crate::geometry::{Point, Transform, inset_convex, point};
use crate::scene::{HOLES_LAYER, ItemInfo, ItemKind, Part, Pen};
use crate::sexpr::Expr;
use crate::text::{HAlign, TextStyle, VAlign, stroke_text};

/// KiCad's `PCB_RENDER_SETTINGS::MAX_FONT_SIZE`.
const MAX_LABEL_SIZE: f64 = 10.0;

impl Board {
    pub(super) fn pad(&mut self, pad: Expr, footprint: u32, frame: &Transform) {
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
        let size = child_point(pad, "size").unwrap_or_default();
        let drill = pad.child("drill");
        let offset = drill
            .and_then(|drill| child_point(drill, "offset"))
            .unwrap_or_default();
        let shape_frame = pad_frame.child(offset, degrees);
        let shape = pad.arg(2).and_then(Expr::atom).unwrap_or("circle");
        for layer in &layers {
            let pen = self.pen(id, layer, Part::Main);
            self.pad_shape(pen, pad, shape, size, &shape_frame);
        }
        let board_size = point(frame.length(size.x), frame.length(size.y));
        self.labels(id, pad, shape, board_size, net, &layers);
        if let Some(drill) = drill {
            let plated = pad.arg(1).and_then(Expr::atom) != Some("np_thru_hole");
            self.drill(id, drill, &pad_frame, plated.then_some(board_size));
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

    fn pad_shape(&mut self, pen: Pen, pad: Expr, shape: &str, size: Point, frame: &Transform) {
        let half = size * 0.5;
        match shape {
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
                let radius = if shape == "roundrect" {
                    pad.number_value("roundrect_rratio").unwrap_or(0.0) * size.x.min(size.y)
                } else {
                    0.0
                };
                let chamfer = pad.number_value("chamfer_ratio").unwrap_or(0.0) * size.x.min(size.y);
                let corners = pad.child("chamfer").filter(|_| chamfer > 0.0);
                match corners {
                    Some(corners) => {
                        let outline =
                            chamfered_rect(half, chamfer, |corner| corners.has_flag(corner));
                        self.rounded(pen, &inset_convex(&outline, radius), radius, frame);
                    }
                    None => {
                        let inner = point((half.x - radius).max(0.0), (half.y - radius).max(0.0));
                        self.rounded(pen, &rect(inner), radius, frame);
                    }
                }
            }
            "trapezoid" => {
                let delta = child_point(pad, "rect_delta").unwrap_or_default() * 0.5;
                let (hx, hy) = (half.x, half.y);
                let corners = [
                    point(-hx - delta.y, hy + delta.x),
                    point(hx + delta.y, hy - delta.x),
                    point(hx - delta.y, -hy + delta.x),
                    point(-hx + delta.y, -hy - delta.x),
                ];
                self.rounded(pen, &corners, 0.0, frame);
            }
            "custom" => {
                let anchor = match pad
                    .child("options")
                    .and_then(|options| options.value("anchor"))
                    .as_deref()
                {
                    Some("rect") => "rect",
                    _ => "circle",
                };
                self.pad_shape(pen, pad, anchor, size, frame);
                for primitive in pad.child("primitives").into_iter().flat_map(Expr::args) {
                    let Some(name) = primitive.head().and_then(|head| head.strip_prefix("gr_"))
                    else {
                        continue;
                    };
                    self.shape(pen, primitive, name, frame, true);
                }
            }
            _ => {}
        }
    }

    /// Fills a convex polygon and strokes its edges with `2 × radius` to round its corners.
    fn rounded(&mut self, pen: Pen, local: &[Point], radius: f64, frame: &Transform) {
        let outline: Vec<Point> = local.iter().map(|&p| frame.apply(p)).collect();
        self.scene.polygon(pen, &outline, &[]);
        if radius > 0.0 {
            self.scene
                .polyline(pen, &outline, frame.length(radius * 2.0), true);
        }
    }

    /// Plated holes, given their pad's size, get a wall drawn around them as in KiCad.
    fn drill(&mut self, id: u32, drill: Expr, frame: &Transform, plated_pad_size: Option<Point>) {
        let numbers: Vec<f64> = drill.args().filter_map(Expr::number).collect();
        let (along, thickness) = match (drill.has_flag("oval"), numbers.as_slice()) {
            (true, &[width, height, ..]) => {
                let thickness = width.min(height);
                let along = point((width - thickness) / 2.0, (height - thickness) / 2.0);
                (frame.apply_vector(along), frame.length(thickness))
            }
            (_, &[diameter, ..]) => (Point::default(), frame.length(diameter)),
            _ => return,
        };
        let center = frame.origin();
        let mut hole = |part: Part, width: f64| {
            let pen = self.pen(id, HOLES_LAYER, part);
            if along == Point::default() {
                self.scene.circle(pen, center, width / 2.0, 0.0);
            } else {
                self.scene
                    .segment(pen, center - along, center + along, width);
            }
        };
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

fn rect(half: Point) -> [Point; 4] {
    [
        point(-half.x, -half.y),
        point(half.x, -half.y),
        point(half.x, half.y),
        point(-half.x, half.y),
    ]
}

fn chamfered_rect(half: Point, chamfer: f64, cut: impl Fn(&str) -> bool) -> Vec<Point> {
    let (hx, hy, c) = (half.x, half.y, chamfer);
    let mut outline = Vec::with_capacity(8);
    let mut corner = |name: &str, square: Point, before: Point, after: Point| {
        if cut(name) {
            outline.extend([before, after]);
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
