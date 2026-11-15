use crate::geometry::{Arc, Point, Transform};
use crate::scene::{Pen, Scene};
use crate::sexpr::Expr;

const MAX_PATTERN_ELEMENTS: usize = 10_000;

#[derive(Clone, Copy)]
pub(super) struct Stroke {
    pub width: f64,
    style: Style,
}

#[derive(Clone, Copy)]
enum Style {
    Solid,
    Dash,
    Dot,
    DashDot,
    DashDotDot,
}

impl Stroke {
    pub fn from_expr(item: Expr, default_width: f64) -> Self {
        let stroke = item.child("stroke");
        Self {
            width: stroke
                .and_then(|stroke| stroke.number_value("width"))
                .or_else(|| item.number_value("width"))
                .unwrap_or(default_width),
            style: match stroke.and_then(|stroke| stroke.value("type")).as_deref() {
                Some("dash") => Style::Dash,
                Some("dot") => Style::Dot,
                Some("dash_dot") => Style::DashDot,
                Some("dash_dot_dot") => Style::DashDotDot,
                _ => Style::Solid,
            },
        }
    }

    pub fn scaled(self, frame: &Transform) -> Self {
        Self {
            width: frame.length(self.width),
            ..self
        }
    }

    pub fn is_solid(self) -> bool {
        matches!(self.style, Style::Solid)
    }

    fn pattern(self) -> &'static [f64] {
        match self.style {
            Style::Solid => &[],
            Style::Dash => &[11.0, 4.0],
            Style::Dot => &[0.2, 4.0],
            Style::DashDot => &[11.0, 4.0, 0.2, 4.0],
            Style::DashDotDot => &[11.0, 4.0, 0.2, 4.0, 0.2, 4.0],
        }
    }

    pub fn line(self, scene: &mut Scene, pen: Pen, a: Point, b: Point) {
        self.chain(scene, pen, &[a, b]);
    }

    pub fn closed(self, scene: &mut Scene, pen: Pen, points: &[Point]) {
        if self.is_solid() {
            scene.polyline(pen, points, self.width, true);
            return;
        }
        for pair in points.windows(2) {
            self.line(scene, pen, pair[0], pair[1]);
        }
        if points.len() > 2 {
            self.line(scene, pen, points[points.len() - 1], points[0]);
        }
    }

    pub fn chain(self, scene: &mut Scene, pen: Pen, points: &[Point]) {
        if self.is_solid() {
            scene.polyline(pen, points, self.width, false);
            return;
        }
        if !self.width.is_finite() || self.width <= 0.0 {
            return;
        }
        let pattern = self.pattern();
        let mut element = 0;
        let mut remaining = pattern[0] * self.width;
        for pair in points.windows(2) {
            let delta = pair[1] - pair[0];
            let length = delta.length();
            if !length.is_finite() {
                continue;
            }
            let mut walked = 0.0;
            for _ in 0..MAX_PATTERN_ELEMENTS {
                if walked >= length {
                    break;
                }
                let step = remaining.min(length - walked);
                let next = walked + step;
                if element % 2 == 0 {
                    scene.segment(
                        pen,
                        pair[0] + delta * (walked / length),
                        pair[0] + delta * (next / length),
                        self.width,
                    );
                }
                walked = next;
                remaining -= step;
                if remaining <= 0.0 {
                    element = (element + 1) % pattern.len();
                    remaining = pattern[element] * self.width;
                }
            }
        }
    }

    pub fn arc(self, scene: &mut Scene, pen: Pen, mut arc: Arc, frame: &Transform) {
        if self.is_solid() {
            let points: Vec<_> = arc.points().into_iter().map(|p| frame.apply(p)).collect();
            scene.polyline(pen, &points, self.width, false);
            return;
        }
        if !self.width.is_finite() || self.width <= 0.0 || arc.radius <= 0.0 {
            return;
        }
        // KiCad stores shape arcs with positive winding, independent of the file's ends.
        if arc.sweep < 0.0 {
            arc.start += arc.sweep;
            arc.sweep = -arc.sweep;
        }
        let pattern = self.pattern();
        let sweep = arc.sweep;
        let radians_per_mm = 1.0 / frame.length(arc.radius);
        let mut walked = 0.0;
        for element in 0..MAX_PATTERN_ELEMENTS {
            if walked >= sweep {
                break;
            }
            let step = (pattern[element % pattern.len()] * self.width * radians_per_mm)
                .min(sweep - walked);
            if element % 2 == 0 {
                let piece = Arc {
                    start: arc.start + walked,
                    sweep: step,
                    ..arc
                };
                let points: Vec<_> = piece.points().into_iter().map(|p| frame.apply(p)).collect();
                scene.polyline(pen, &points, self.width, false);
            }
            walked += step;
        }
    }
}
