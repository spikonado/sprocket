use std::f64::consts::{PI, TAU};
use std::ops::{Add, Mul, Neg, Sub};

/// The largest distance a tessellated arc or curve may stray from the true shape, in mm.
pub const MAX_CHORD_ERROR: f64 = 0.005;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

pub const fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

impl Point {
    pub fn length(self) -> f64 {
        self.x.hypot(self.y)
    }

    pub fn resized(self, length: f64) -> Point {
        let current = self.length();
        if current == 0.0 {
            return self;
        }
        self * (length / current)
    }

    /// Rotates like KiCad's `RotatePoint`: positive angles turn counterclockwise on screen,
    /// where y points down.
    pub fn rotated(self, degrees: f64) -> Point {
        if degrees == 0.0 {
            return self;
        }
        let (sin, cos) = degrees.to_radians().sin_cos();
        point(self.x * cos + self.y * sin, self.y * cos - self.x * sin)
    }
}

impl Add for Point {
    type Output = Point;
    fn add(self, other: Point) -> Point {
        point(self.x + other.x, self.y + other.y)
    }
}

impl Sub for Point {
    type Output = Point;
    fn sub(self, other: Point) -> Point {
        point(self.x - other.x, self.y - other.y)
    }
}

impl Mul<f64> for Point {
    type Output = Point;
    fn mul(self, factor: f64) -> Point {
        point(self.x * factor, self.y * factor)
    }
}

impl Neg for Point {
    type Output = Point;
    fn neg(self) -> Point {
        point(-self.x, -self.y)
    }
}

/// Scale, then rotate in KiCad's sense, then translate.
#[derive(Clone, Copy, Debug)]
pub struct Transform {
    origin: Point,
    degrees: f64,
    scale: Point,
}

impl Transform {
    pub const IDENTITY: Transform = Transform {
        origin: point(0.0, 0.0),
        degrees: 0.0,
        scale: point(1.0, 1.0),
    };

    pub fn new(origin: Point, degrees: f64, scale: Point) -> Transform {
        Transform {
            origin,
            degrees,
            scale,
        }
    }

    pub fn apply(&self, p: Point) -> Point {
        self.origin + self.apply_vector(p)
    }

    pub fn apply_vector(&self, v: Point) -> Point {
        point(v.x * self.scale.x, v.y * self.scale.y).rotated(self.degrees)
    }

    /// Scales a length such as a stroke width.
    pub fn length(&self, length: f64) -> f64 {
        length * (self.scale.x.abs() + self.scale.y.abs()) * 0.5
    }

    pub fn origin(&self) -> Point {
        self.origin
    }

    pub fn degrees(&self) -> f64 {
        self.degrees
    }

    pub fn scale(&self) -> Point {
        self.scale
    }

    /// A child frame placed at `origin` in this frame, with an absolute rotation, as KiCad
    /// stores pads.
    pub fn child(&self, origin: Point, absolute_degrees: f64) -> Transform {
        Transform::new(self.apply(origin), absolute_degrees, self.scale)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub min: Point,
    pub max: Point,
}

impl Bounds {
    pub const EMPTY: Bounds = Bounds {
        min: point(f64::INFINITY, f64::INFINITY),
        max: point(f64::NEG_INFINITY, f64::NEG_INFINITY),
    };

    pub fn is_empty(&self) -> bool {
        self.min.x > self.max.x
    }

    pub fn include(&mut self, p: Point, margin: f64) {
        self.min.x = self.min.x.min(p.x - margin);
        self.min.y = self.min.y.min(p.y - margin);
        self.max.x = self.max.x.max(p.x + margin);
        self.max.y = self.max.y.max(p.y + margin);
    }

    pub fn merge(&mut self, other: &Bounds) {
        if !other.is_empty() {
            self.include(other.min, 0.0);
            self.include(other.max, 0.0);
        }
    }
}

impl Default for Bounds {
    fn default() -> Self {
        Bounds::EMPTY
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Arc {
    pub center: Point,
    pub radius: f64,
    /// Start angle in radians, measured with y pointing down.
    pub start: f64,
    /// Signed sweep in radians, measured with y pointing down.
    pub sweep: f64,
}

impl Arc {
    /// The arc through three points, or `None` when they are collinear.
    pub fn through(start: Point, mid: Point, end: Point) -> Option<Arc> {
        let center = circle_center(start, mid, end)?;
        let angle = |p: Point| (p.y - center.y).atan2(p.x - center.x);
        let (a0, a1, a2) = (angle(start), angle(mid), angle(end));
        let ccw = |from: f64, to: f64| (to - from).rem_euclid(TAU);
        let sweep = if ccw(a0, a1) <= ccw(a0, a2) {
            ccw(a0, a2)
        } else {
            ccw(a0, a2) - TAU
        };
        let sweep = if sweep == 0.0 && start == end {
            TAU
        } else {
            sweep
        };
        Some(Arc {
            center,
            radius: (start - center).length(),
            start: a0,
            sweep,
        })
    }

    /// KiCad 5's arcs: a center, a start point and a sweep in degrees.
    pub fn from_center(center: Point, start: Point, sweep_degrees: f64) -> Arc {
        let offset = start - center;
        Arc {
            center,
            radius: offset.length(),
            start: offset.y.atan2(offset.x),
            sweep: sweep_degrees.to_radians(),
        }
    }

    pub fn points(&self) -> Vec<Point> {
        let steps = arc_steps(self.radius, self.sweep);
        (0..=steps)
            .map(|step| {
                let angle = self.start + self.sweep * step as f64 / steps as f64;
                self.center + point(angle.cos(), angle.sin()) * self.radius
            })
            .collect()
    }
}

fn arc_steps(radius: f64, sweep: f64) -> usize {
    let max_step = if radius > MAX_CHORD_ERROR {
        2.0 * (1.0 - MAX_CHORD_ERROR / radius).acos()
    } else {
        PI / 2.0
    };
    ((sweep.abs() / max_step).ceil() as usize).clamp(1, 2048)
}

fn circle_center(a: Point, b: Point, c: Point) -> Option<Point> {
    let d = 2.0 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if d.abs() < 1e-12 {
        return None;
    }
    let (a2, b2, c2) = (
        a.x * a.x + a.y * a.y,
        b.x * b.x + b.y * b.y,
        c.x * c.x + c.y * c.y,
    );
    Some(point(
        (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
        (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
    ))
}

pub fn cubic_bezier(p: [Point; 4]) -> Vec<Point> {
    let bend = |a: Point, b: Point, c: Point| (a - b * 2.0 + c).length();
    let curvature = 6.0 * bend(p[0], p[1], p[2]).max(bend(p[1], p[2], p[3]));
    let steps = ((curvature / (8.0 * MAX_CHORD_ERROR)).sqrt().ceil() as usize).clamp(1, 256);
    (0..=steps)
        .map(|step| {
            let t = step as f64 / steps as f64;
            let u = 1.0 - t;
            p[0] * (u * u * u)
                + p[1] * (3.0 * u * u * t)
                + p[2] * (3.0 * u * t * t)
                + p[3] * (t * t * t)
        })
        .collect()
}

/// Moves every edge of a convex polygon inward by `distance`.
pub fn inset_convex(polygon: &[Point], distance: f64) -> Vec<Point> {
    let n = polygon.len();
    if n < 3 || distance <= 0.0 {
        return polygon.to_vec();
    }
    let area: f64 = (0..n)
        .map(|i| {
            let (a, b) = (polygon[i], polygon[(i + 1) % n]);
            a.x * b.y - b.x * a.y
        })
        .sum();
    let side = if area > 0.0 { 1.0 } else { -1.0 };
    let edge = |i: usize| {
        let (a, b) = (polygon[i], polygon[(i + 1) % n]);
        let dir = b - a;
        let normal = point(-dir.y, dir.x).resized(distance * side);
        (a + normal, dir)
    };
    (0..n)
        .map(|i| {
            let (p1, d1) = edge((i + n - 1) % n);
            let (p2, d2) = edge(i);
            let cross = d1.x * d2.y - d1.y * d2.x;
            if cross.abs() < 1e-12 {
                return p2;
            }
            let t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / cross;
            p1 + d1 * t
        })
        .collect()
}

/// Sutherland–Hodgman clipping of a ring against the half-plane on one side of the line
/// `x = at` (`vertical`) or `y = at`. Points on the line count as inside.
pub fn clip_ring(ring: &[Point], vertical: bool, at: f64, keep_below: bool) -> Vec<Point> {
    let value = |p: Point| if vertical { p.x } else { p.y };
    let inside = |p: Point| {
        if keep_below {
            value(p) <= at
        } else {
            value(p) >= at
        }
    };
    let crossing = |a: Point, b: Point| {
        let t = (at - value(a)) / (value(b) - value(a));
        let p = a + (b - a) * t;
        if vertical {
            point(at, p.y)
        } else {
            point(p.x, at)
        }
    };
    let mut out = Vec::with_capacity(ring.len() / 2 + 4);
    let Some(&last) = ring.last() else {
        return out;
    };
    let mut previous = last;
    for &current in ring {
        match (inside(previous), inside(current)) {
            (true, true) => out.push(current),
            (true, false) => out.push(crossing(previous, current)),
            (false, true) => out.extend([crossing(previous, current), current]),
            (false, false) => {}
        }
        previous = current;
    }
    out
}

#[cfg(test)]
mod tests;
