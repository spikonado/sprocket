use std::f64::consts::{PI, TAU};

use i_overlay::core::fill_rule::FillRule;
use i_overlay::float::simplify::SimplifyShape;
use i_overlay::mesh::float::outline::offset::OutlineOffset;
use i_overlay::mesh::float::style::{LineJoin, OutlineStyle};

use super::{CIRCLE_BYTES, SEGMENT_BYTES, Scene, VERTEX_BYTES};
use crate::geometry::{Arc, MAX_CHORD_ERROR, Point, point};

impl Scene {
    /// Offsets the union, so erosion keeps joins between overlapping primitives intact.
    pub fn offset_polygons(&self, margin: f64) -> Vec<Vec<Vec<Point>>> {
        let mut contours = Vec::new();
        for layer in &self.layers {
            for record in layer.segments.as_chunks::<SEGMENT_BYTES>().0 {
                let a = position(record, 0);
                let b = position(record, 2);
                let radius = float(record, 4) / 2.0;
                let angle = (b.y - a.y).atan2(b.x - a.x);
                let mut capsule = arc(a, radius, angle + PI / 2.0, PI);
                capsule.extend(arc(b, radius, angle - PI / 2.0, PI));
                contours.push(capsule);
            }
            for record in layer.circles.as_chunks::<CIRCLE_BYTES>().0 {
                let center = position(record, 0);
                let radius = float(record, 2);
                let stroke = float(record, 3);
                contours.push(arc(center, radius + stroke / 2.0, 0.0, TAU));
                if stroke > 0.0 && radius > stroke / 2.0 {
                    contours.push(arc(center, radius - stroke / 2.0, 0.0, -TAU));
                }
            }
            for record in layer.triangles.as_chunks::<{ 3 * VERTEX_BYTES }>().0 {
                let a = position(record, 0);
                let b = position(record, 3);
                let c = position(record, 6);
                let cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
                let triangle = if cross < 0.0 { [a, c, b] } else { [a, b, c] };
                contours.push(triangle.into_iter().map(|p| [p.x, p.y]).collect());
            }
        }
        let union = contours.simplify_shape(FillRule::NonZero);
        let polygons = if margin == 0.0 || union.is_empty() {
            union
        } else {
            let angle = if margin.abs() > MAX_CHORD_ERROR {
                2.0 * (1.0 - MAX_CHORD_ERROR / margin.abs()).acos()
            } else {
                PI / 2.0
            };
            union.outline(&OutlineStyle::new(margin).line_join(LineJoin::Round(angle)))
        };
        polygons
            .into_iter()
            .map(|polygon| {
                polygon
                    .into_iter()
                    .map(|ring| ring.into_iter().map(|[x, y]| point(x, y)).collect())
                    .collect()
            })
            .collect()
    }
}

fn float(record: &[u8], field: usize) -> f64 {
    f64::from(f32::from_le_bytes(
        record[field * 4..field * 4 + 4].try_into().unwrap(),
    ))
}

fn position(record: &[u8], field: usize) -> Point {
    point(float(record, field), float(record, field + 1))
}

fn arc(center: Point, radius: f64, start: f64, sweep: f64) -> Vec<[f64; 2]> {
    Arc {
        center,
        radius,
        start,
        sweep,
    }
    .points()
    .into_iter()
    .map(|p| [p.x, p.y])
    .collect()
}
