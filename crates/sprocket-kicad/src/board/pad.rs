//! Footprint pads and their drill holes.

use super::{Board, child_point, xy};
use crate::geometry::{Point, Transform, inset_convex, point};
use crate::scene::{HOLES_LAYER, ItemInfo, ItemKind, Pen};
use crate::sexpr::Expr;

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
            let pen = self.pen(id, layer);
            self.pad_shape(pen, pad, shape, size, &shape_frame);
        }
        if let Some(drill) = drill {
            self.drill(id, drill, &pad_frame);
        }
        self.scene.merge_bounds(footprint, id);
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

    fn drill(&mut self, id: u32, drill: Expr, frame: &Transform) {
        let pen = self.pen(id, HOLES_LAYER);
        let numbers: Vec<f64> = drill.args().filter_map(Expr::number).collect();
        match (drill.has_flag("oval"), numbers.as_slice()) {
            (true, &[width, height, ..]) => {
                let thickness = width.min(height);
                let along = point((width - thickness) / 2.0, (height - thickness) / 2.0);
                self.scene.segment(
                    pen,
                    frame.apply(-along),
                    frame.apply(along),
                    frame.length(thickness),
                );
            }
            (_, &[diameter, ..]) => {
                self.scene
                    .circle(pen, frame.origin(), frame.length(diameter / 2.0), 0.0)
            }
            _ => {}
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
