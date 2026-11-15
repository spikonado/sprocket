use std::f64::consts::PI;

use i_overlay::core::fill_rule::FillRule;
use i_overlay::float::simplify::SimplifyShape;
use i_overlay::mesh::float::outline::offset::OutlineOffset;
use i_overlay::mesh::float::style::{LineJoin, OutlineStyle};

use super::{CIRCLE_BYTES, SEGMENT_BYTES, Scene, VERTEX_BYTES, record_float, record_point};
use crate::geometry::polygon::{Polygon, capsule, from_overlay};
use crate::geometry::{Arc, MAX_CHORD_ERROR, Point, point};

impl Scene {
    /// Offsets the union, so erosion keeps joins between overlapping primitives intact.
    pub fn offset_polygons(&self, margin: f64) -> Vec<Polygon> {
        let xy = |points: Vec<Point>| points.into_iter().map(|p| [p.x, p.y]).collect::<Vec<_>>();
        let mut contours = Vec::new();
        for layer in &self.layers {
            for record in layer.segments.as_chunks::<SEGMENT_BYTES>().0 {
                let a = record_point(record, 0);
                let b = record_point(record, 2);
                let radius = record_float(record, 4) / 2.0;
                contours.push(xy(capsule(a, b, radius)));
            }
            for record in layer.circles.as_chunks::<CIRCLE_BYTES>().0 {
                let center = record_point(record, 0);
                let radius = record_float(record, 2);
                let stroke = record_float(record, 3);
                let ring = |radius: f64, degrees| {
                    xy(Arc::from_center(center, center + point(radius, 0.0), degrees).points())
                };
                contours.push(ring(radius + stroke / 2.0, 360.0));
                if stroke > 0.0 && radius > stroke / 2.0 {
                    contours.push(ring(radius - stroke / 2.0, -360.0));
                }
            }
            for record in layer.triangles.as_chunks::<{ 3 * VERTEX_BYTES }>().0 {
                let a = record_point(record, 0);
                let b = record_point(record, 3);
                let c = record_point(record, 6);
                let cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
                let triangle = if cross < 0.0 {
                    vec![a, c, b]
                } else {
                    vec![a, b, c]
                };
                contours.push(xy(triangle));
            }
        }
        let union = contours.simplify_shape(FillRule::NonZero);
        if margin == 0.0 || union.is_empty() {
            return from_overlay(union);
        }
        let angle = if margin.abs() > MAX_CHORD_ERROR {
            2.0 * (1.0 - MAX_CHORD_ERROR / margin.abs()).acos()
        } else {
            PI / 2.0
        };
        from_overlay(union.outline(&OutlineStyle::new(margin).line_join(LineJoin::Round(angle))))
    }
}
