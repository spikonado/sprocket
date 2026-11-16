use std::f64::consts::PI;

use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;

use super::{Arc, Point, point};

pub type Polygon = Vec<Vec<Point>>;

/// The outline of the segment from `a` to `b` with round ends of `radius`.
pub fn capsule(a: Point, b: Point, radius: f64) -> Vec<Point> {
    let angle = (b.y - a.y).atan2(b.x - a.x);
    let half_turn = |center, start| {
        Arc {
            center,
            radius,
            start,
            sweep: PI,
        }
        .points()
    };
    let mut ring = half_turn(a, angle + PI / 2.0);
    ring.extend(half_turn(b, angle - PI / 2.0));
    ring
}

pub fn stroke_outline(strokes: &[Vec<Point>], width: f64) -> Vec<Polygon> {
    if width <= 0.0 || !width.is_finite() {
        return Vec::new();
    }
    let radius = width / 2.0;
    strokes
        .iter()
        .flat_map(|stroke| match stroke[..] {
            [p] => vec![vec![capsule(p, p, radius)]],
            _ => stroke
                .windows(2)
                .map(|pair| vec![capsule(pair[0], pair[1], radius)])
                .collect(),
        })
        .collect()
}

/// Converts `i_overlay` shapes back to polygons.
pub fn from_overlay(shapes: Vec<Vec<Vec<[f64; 2]>>>) -> Vec<Polygon> {
    shapes
        .into_iter()
        .map(|shape| {
            shape
                .into_iter()
                .map(|ring| ring.into_iter().map(|[x, y]| point(x, y)).collect())
                .collect()
        })
        .collect()
}

pub fn difference(subject: &[Polygon], clip: &[Polygon]) -> Vec<Polygon> {
    let contours = |polygons: &[Polygon]| {
        polygons
            .iter()
            .flat_map(|polygon| {
                polygon.iter().enumerate().map(|(index, ring)| {
                    let mut ring: Vec<_> = ring.iter().map(|p| [p.x, p.y]).collect();
                    let area: f64 = ring
                        .iter()
                        .zip(ring.iter().cycle().skip(1))
                        .map(|(a, b)| a[0] * b[1] - b[0] * a[1])
                        .sum();
                    if (area > 0.0) != (index == 0) {
                        ring.reverse();
                    }
                    ring
                })
            })
            .collect::<Vec<_>>()
    };
    let subject = contours(subject);
    let clip = contours(clip);
    from_overlay(subject.overlay(&clip, OverlayRule::Difference, FillRule::NonZero))
}
