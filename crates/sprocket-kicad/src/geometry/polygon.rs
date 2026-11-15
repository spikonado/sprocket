use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;

use super::{Arc, Point, point};

pub type Polygon = Vec<Vec<Point>>;

pub fn stroke_outline(strokes: &[Vec<Point>], width: f64) -> Vec<Polygon> {
    if width <= 0.0 || !width.is_finite() {
        return Vec::new();
    }
    let mut polygons = Vec::new();
    for stroke in strokes {
        if let [p] = stroke[..] {
            polygons.push(vec![
                Arc::from_center(p, p + point(width / 2.0, 0.0), 360.0).points(),
            ]);
        }
        for pair in stroke.windows(2) {
            let delta = pair[1] - pair[0];
            let normal = if delta.length() == 0.0 {
                point(0.0, width / 2.0)
            } else {
                point(-delta.y, delta.x).resized(width / 2.0)
            };
            let mut ring = Arc::from_center(pair[0], pair[0] + normal, 180.0).points();
            ring.extend(Arc::from_center(pair[1], pair[1] - normal, 180.0).points());
            polygons.push(vec![ring]);
        }
    }
    polygons
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
    subject
        .overlay(&clip, OverlayRule::Difference, FillRule::NonZero)
        .into_iter()
        .map(|polygon| {
            polygon
                .into_iter()
                .map(|ring| ring.into_iter().map(|[x, y]| point(x, y)).collect())
                .collect()
        })
        .collect()
}
