//! Graphic shapes, text and dimensions.

use std::borrow::Cow;

use super::{Board, FIRST_BOLD_MULTIPLIER, Fields, LAST_IMPLICIT_POLY_FILL, child_point, points};
use crate::geometry::{Arc, Bounds, Point, Transform, cubic_bezier, point};
use crate::scene::{ItemInfo, ItemKind, Pen, Scene};
use crate::sexpr::Expr;
use crate::text::{HAlign, TextStyle, VAlign, pen_width, stroke_text};

const ARROW_ANGLE: f64 = 27.5;

/// Shape names after their `gr_`/`fp_` prefix.
pub(super) fn is_shape(name: &str) -> bool {
    matches!(name, "line" | "arc" | "circle" | "rect" | "poly" | "curve")
}

impl Board {
    pub(super) fn board_shape(&mut self, shape: Expr, name: &str) {
        let Some(layer) = shape.value("layer") else {
            return;
        };
        let net = self.net(shape);
        let id = self.scene.add_item(
            ItemKind::Shape,
            ItemInfo {
                layer: Some(layer.to_string()),
                net,
                ..ItemInfo::default()
            },
        );
        let pen = self.pen(id, &layer);
        self.shape(pen, shape, name, &Transform::IDENTITY, false);
    }

    /// Draws a line, arc, circle, rect, poly or curve. `default_fill` fills closed shapes
    /// that have no `(fill)` and no width, as legacy pad primitives expect.
    pub(super) fn shape(
        &mut self,
        pen: Pen,
        shape: Expr,
        name: &str,
        frame: &Transform,
        default_fill: bool,
    ) {
        let width = shape
            .child("stroke")
            .and_then(|stroke| stroke.number_value("width"))
            .or_else(|| shape.number_value("width"))
            .unwrap_or(0.0);
        let explicit_fill = shape.child("fill").map(|fill| {
            fill.arg(0)
                .and_then(Expr::atom)
                .is_none_or(|value| !matches!(value, "no" | "none"))
        });
        let implicit_fill = match name {
            "poly" => default_fill || self.version <= LAST_IMPLICIT_POLY_FILL,
            _ => default_fill && width == 0.0,
        };
        let filled = explicit_fill.unwrap_or(implicit_fill);
        let width = frame.length(width);
        let at = |key: &str| child_point(shape, key).map(|p| frame.apply(p));
        match name {
            "line" => {
                if let (Some(start), Some(end)) = (at("start"), at("end")) {
                    self.scene.segment(pen, start, end, width);
                }
            }
            "arc" => {
                let (Some(start), Some(end)) =
                    (child_point(shape, "start"), child_point(shape, "end"))
                else {
                    return;
                };
                let arc = match (child_point(shape, "mid"), shape.number_value("angle")) {
                    (Some(mid), _) => Arc::through(start, mid, end),
                    // KiCad 5 arcs store the center in `start` and the arc's start in `end`.
                    (None, Some(angle)) => Some(Arc::from_center(start, end, angle)),
                    (None, None) => None,
                };
                match arc {
                    Some(arc) => {
                        let points: Vec<Point> =
                            arc.points().into_iter().map(|p| frame.apply(p)).collect();
                        self.scene.polyline(pen, &points, width, false);
                    }
                    None => self
                        .scene
                        .segment(pen, frame.apply(start), frame.apply(end), width),
                }
            }
            "circle" => {
                let (Some(center), Some(end)) =
                    (child_point(shape, "center"), child_point(shape, "end"))
                else {
                    return;
                };
                let radius = frame.length((end - center).length());
                if filled {
                    self.scene
                        .circle(pen, frame.apply(center), radius + width / 2.0, 0.0);
                } else {
                    self.scene.circle(pen, frame.apply(center), radius, width);
                }
            }
            "rect" => {
                let (Some(a), Some(b)) = (child_point(shape, "start"), child_point(shape, "end"))
                else {
                    return;
                };
                let corners: Vec<Point> = [a, point(b.x, a.y), b, point(a.x, b.y)]
                    .into_iter()
                    .map(|p| frame.apply(p))
                    .collect();
                self.closed_shape(pen, &corners, width, filled);
            }
            "poly" => {
                let Some(pts) = shape.child("pts") else {
                    return;
                };
                let outline: Vec<Point> = points(pts).into_iter().map(|p| frame.apply(p)).collect();
                self.closed_shape(pen, &outline, width, filled);
            }
            "curve" => {
                let Some(pts) = shape.child("pts") else {
                    return;
                };
                if let [a, b, c, d] = points(pts)[..] {
                    let curve: Vec<Point> = cubic_bezier([a, b, c, d])
                        .into_iter()
                        .map(|p| frame.apply(p))
                        .collect();
                    self.scene.polyline(pen, &curve, width, false);
                }
            }
            _ => {}
        }
    }

    fn closed_shape(&mut self, pen: Pen, outline: &[Point], width: f64, filled: bool) {
        if filled {
            self.scene.polygon(pen, outline, &[]);
        }
        self.scene.polyline(pen, outline, width, true);
    }

    pub(super) fn board_text(&mut self, text: Expr) {
        let Some(raw) = text.text_arg(0) else {
            return;
        };
        let layer = text.value("layer");
        let shown = self.expand(&raw, None, layer.as_deref().unwrap_or(""));
        let id = self.scene.add_item(
            ItemKind::Text,
            ItemInfo {
                layer: layer.map(Into::into),
                text: Some(shown.into_owned()),
                ..ItemInfo::default()
            },
        );
        self.text(id, text, &raw, &Transform::IDENTITY, None);
    }

    /// Draws a text item and returns the box around its strokes.
    pub(super) fn text(
        &mut self,
        item: u32,
        text: Expr,
        raw: &str,
        frame: &Transform,
        fields: Option<&Fields>,
    ) -> Bounds {
        let mut bounds = Bounds::EMPTY;
        let Some(layer) = text.value("layer") else {
            return bounds;
        };
        let effects = text.child("effects");
        let hidden = text.flag("hide") || effects.is_some_and(|effects| effects.flag("hide"));
        if hidden || raw.is_empty() {
            return bounds;
        }
        let pen = self.pen(item, &layer);
        let font = effects.and_then(|effects| effects.child("font"));
        if let (Some(_), Some(cache)) = (
            font.and_then(|font| font.child("face")),
            text.child("render_cache"),
        ) {
            for polygon in cache.children_named("polygon") {
                let mut rings = polygon.children_named("pts").map(points);
                let Some(outline) = rings.next() else {
                    continue;
                };
                let holes: Vec<Vec<Point>> = rings.collect();
                for &p in &outline {
                    bounds.include(p, 0.0);
                }
                self.scene.polygon(pen, &outline, &holes);
            }
            return bounds;
        }

        let shown = self.expand(raw, fields, &layer);
        let at = text.child("at");
        let anchor = frame.apply(at.and_then(super::xy).unwrap_or_default());
        let mut degrees = at.and_then(|at| at.number_arg(2)).unwrap_or(0.0);
        let keep_upright = fields.is_some()
            && !text.flag("unlocked")
            && !at.is_some_and(|at| at.has_flag("unlocked"));
        if keep_upright {
            degrees = 90.0 - (90.0 - degrees).rem_euclid(180.0);
        } else {
            degrees = degrees.rem_euclid(360.0);
        }
        let scale = frame.scale();
        let size = font
            .and_then(|font| font.child("size"))
            .and_then(super::xy)
            .map_or(point(1.27, 1.27), |size| point(size.y, size.x));
        let size = point(size.x * scale.x.abs(), size.y * scale.y.abs());
        let bold = font.is_some_and(|font| font.flag("bold"));
        let thickness = frame.length(
            font.and_then(|font| font.number_value("thickness"))
                .unwrap_or(0.0),
        );
        let justify = effects.and_then(|effects| effects.child("justify"));
        let justified = |flag: &str| justify.is_some_and(|justify| justify.has_flag(flag));
        let style = TextStyle {
            size,
            pen_width: pen_width(thickness, size, bold, self.version >= FIRST_BOLD_MULTIPLIER),
            degrees,
            mirrored: justified("mirror"),
            italic: font.is_some_and(|font| font.flag("italic")),
            h_align: if justified("left") {
                HAlign::Left
            } else if justified("right") {
                HAlign::Right
            } else {
                HAlign::Center
            },
            v_align: if justified("top") {
                VAlign::Top
            } else if justified("bottom") {
                VAlign::Bottom
            } else {
                VAlign::Center
            },
            line_spacing: font
                .and_then(|font| font.number_value("line_spacing"))
                .unwrap_or(1.0),
        };
        for stroke in stroke_text(&shown, anchor, &style) {
            for &p in &stroke {
                bounds.include(p, style.pen_width / 2.0);
            }
            self.scene.polyline(pen, &stroke, style.pen_width, false);
        }
        bounds
    }

    /// Replaces `${NAME}` with footprint fields and board variables, leaving unknown ones.
    fn expand<'t>(&self, text: &'t str, fields: Option<&Fields>, layer: &str) -> Cow<'t, str> {
        if !text.contains("${") {
            return Cow::Borrowed(text);
        }
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(open) = rest.find("${") {
            let Some(close) = rest[open..].find('}') else {
                break;
            };
            out.push_str(&rest[..open]);
            let name = &rest[open + 2..open + close];
            let value = fields
                .and_then(|fields| fields.get(name))
                .or_else(|| self.vars.get(name))
                .map(String::as_str)
                .or((name == "LAYER").then_some(layer));
            match value {
                Some(value) => out.push_str(value),
                None => out.push_str(&rest[open..=open + close]),
            }
            rest = &rest[open + close + 1..];
        }
        out.push_str(rest);
        Cow::Owned(out)
    }

    /// After KiCanvas's `DimensionPainter`, which follows KiCad's `updateGeometry` methods.
    pub(super) fn dimension(&mut self, dimension: Expr, parent: Option<u32>) {
        let Some(layer) = dimension.value("layer") else {
            return;
        };
        let mut pts = dimension
            .child("pts")
            .map(points)
            .unwrap_or_default()
            .into_iter();
        let (Some(start), Some(end)) = (pts.next(), pts.next()) else {
            return;
        };
        let id = self.scene.add_item(
            ItemKind::Dimension,
            ItemInfo {
                parent,
                layer: Some(layer.to_string()),
                text: dimension
                    .child("gr_text")
                    .and_then(|text| text.text_arg(0))
                    .map(Into::into),
                ..ItemInfo::default()
            },
        );
        let pen = self.pen(id, &layer);
        let style = dimension.child("style");
        let style_number = |name: &str| style.and_then(|style| style.number_value(name));
        let thickness = style_number("thickness").unwrap_or(0.2);
        let arrow_length = style_number("arrow_length").unwrap_or(1.27);
        let extension_offset = style_number("extension_offset").unwrap_or(0.0);
        let inward = style
            .and_then(|style| style.value("arrow_direction"))
            .as_deref()
            == Some("inward");
        let text = dimension.child("gr_text");
        let text_bounds = text.map_or(Bounds::EMPTY, |text| {
            let raw = text.text_arg(0).unwrap_or_default();
            self.text(id, text, &raw, &Transform::IDENTITY, None)
        });
        let text_position = text.and_then(|text| child_point(text, "at")).unwrap_or(end);
        let height = dimension.number_value("height").unwrap_or(0.0);
        // Arrow wings pointing back along `direction` from `tip`.
        let arrow = |scene: &mut Scene, tip: Point, direction: Point| {
            let wing = direction.resized(if inward { -arrow_length } else { arrow_length });
            let wings = [
                tip + wing.rotated(ARROW_ANGLE),
                tip,
                tip + wing.rotated(-ARROW_ANGLE),
            ];
            scene.polyline(pen, &wings, thickness, false);
        };

        match dimension.value("type").as_deref() {
            Some(kind @ ("aligned" | "orthogonal")) => {
                let (extension, bar_start, bar_end) = if kind == "orthogonal" {
                    if dimension.number_value("orientation").unwrap_or(0.0) == 0.0 {
                        let extension = point(0.0, height);
                        let bar_start = start + extension;
                        (extension, bar_start, point(end.x, bar_start.y))
                    } else {
                        let extension = point(height, 0.0);
                        let bar_start = start + extension;
                        (extension, bar_start, point(bar_start.x, end.y))
                    }
                } else {
                    let span = end - start;
                    let extension = if height > 0.0 {
                        point(-span.y, span.x)
                    } else {
                        point(span.y, -span.x)
                    };
                    let offset = extension.resized(height.abs());
                    (extension, start + offset, end + offset)
                };
                let extension_height = height.abs() - extension_offset
                    + style_number("extension_height").unwrap_or(0.0);
                for base in [start, end] {
                    let from = base + extension.resized(extension_offset);
                    self.scene.segment(
                        pen,
                        from,
                        from + extension.resized(extension_height),
                        thickness,
                    );
                }
                self.scene.segment(pen, bar_start, bar_end, thickness);
                arrow(&mut self.scene, bar_start, bar_end - bar_start);
                arrow(&mut self.scene, bar_end, bar_start - bar_end);
            }
            Some("center") => {
                let arm = end - start;
                for arm in [arm, arm.rotated(90.0)] {
                    self.scene.segment(pen, start - arm, start + arm, thickness);
                }
            }
            Some("radial") => {
                for arm in [point(0.0, arrow_length), point(arrow_length, 0.0)] {
                    self.scene.segment(pen, start - arm, start + arm, thickness);
                }
                let knee = end
                    + (end - start).resized(dimension.number_value("leader_length").unwrap_or(0.0));
                let tail = clip_to_box(knee, text_position, &text_bounds);
                self.scene
                    .polyline(pen, &[end, knee, tail], thickness, false);
                arrow(&mut self.scene, end, end - start);
            }
            Some("leader") => {
                let tip = start + (end - start).resized(extension_offset);
                let tail = clip_to_box(end, text_position, &text_bounds);
                self.scene
                    .polyline(pen, &[tip, end, tail], thickness, false);
                arrow(&mut self.scene, tip, end - start);
                match style_number("text_frame").unwrap_or(0.0) as i64 {
                    1 if !text_bounds.is_empty() => {
                        let (a, b) = (text_bounds.min, text_bounds.max);
                        let frame = [a, point(b.x, a.y), b, point(a.x, b.y)];
                        self.scene.polyline(pen, &frame, thickness, true);
                    }
                    2 if !text_bounds.is_empty() => {
                        let center = (text_bounds.min + text_bounds.max) * 0.5;
                        let radius = (text_bounds.max.x - text_bounds.min.x) / 2.0;
                        self.scene.circle(pen, center, radius, thickness);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

/// Where the segment from `from` to `to` first enters `bounds`, or `to` when it doesn't.
fn clip_to_box(from: Point, to: Point, bounds: &Bounds) -> Point {
    if bounds.is_empty() {
        return to;
    }
    let delta = to - from;
    let mut enter: f64 = 0.0;
    let mut exit: f64 = 1.0;
    for (start, step, min, max) in [
        (from.x, delta.x, bounds.min.x, bounds.max.x),
        (from.y, delta.y, bounds.min.y, bounds.max.y),
    ] {
        if step.abs() < 1e-12 {
            if start < min || start > max {
                return to;
            }
            continue;
        }
        let (a, b) = ((min - start) / step, (max - start) / step);
        enter = enter.max(a.min(b));
        exit = exit.min(a.max(b));
    }
    if enter <= exit {
        from + delta * enter
    } else {
        to
    }
}
