use super::*;
use crate::geometry::Arc;

fn area(flat: &[f64]) -> f64 {
    let ring: Vec<Point> = flat
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&[x, y]| point(x, y))
        .collect();
    signed_area(&ring)
}

#[test]
fn chains_shuffled_pieces_and_nests_holes() {
    let mut edges = EdgeCuts::default();
    // A 10 mm square drawn out of order, one side reversed, with a 5 µm gap.
    edges.open(vec![point(10.0, 10.0), point(10.0, 0.0)]);
    edges.open(vec![point(0.0, 0.0), point(10.0, 0.0)]);
    edges.open(vec![point(0.0, 10.005), point(0.0, 0.0)]);
    edges.open(vec![point(10.0, 10.0), point(0.0, 10.0)]);
    // A tiny slot out of two 1 µm lines and two half circles.
    let slot_arc = |center: Point, start: f64| Arc {
        center,
        radius: 0.0005,
        start,
        sweep: std::f64::consts::PI,
    };
    edges.open(slot_arc(point(5.0, 5.0), -std::f64::consts::FRAC_PI_2).points());
    edges.open(vec![point(5.0, 5.0005), point(4.999, 5.0005)]);
    edges.open(slot_arc(point(4.999, 5.0), std::f64::consts::FRAC_PI_2).points());
    edges.open(vec![point(4.999, 4.9995), point(5.0, 4.9995)]);
    // A circle cutout with an island inside it.
    edges.closed(Arc::from_center(point(2.0, 2.0), point(3.0, 2.0), 360.0).points());
    edges.closed(vec![point(1.9, 1.9), point(2.1, 1.9), point(2.1, 2.1)]);
    // A dangling line that never closes.
    edges.open(vec![point(20.0, 0.0), point(30.0, 0.0)]);

    let outlines = edges.outlines(Bounds::EMPTY);
    assert_eq!(outlines.len(), 2);
    let board = &outlines[0];
    assert!((area(&board.outer) - 100.0).abs() < 0.1);
    assert_eq!(board.holes.len(), 2);
    assert!(board.holes.iter().all(|hole| area(hole) < 0.0));
    assert!((area(&outlines[1].outer) - 0.02).abs() < 1e-9);
}

#[test]
fn falls_back_to_the_bounds_when_nothing_closes() {
    let mut edges = EdgeCuts::default();
    edges.open(vec![point(0.0, 0.0), point(10.0, 0.0)]);
    let bounds = Bounds {
        min: point(-1.0, -2.0),
        max: point(3.0, 4.0),
    };
    assert_eq!(
        edges.outlines(bounds),
        [Outline {
            outer: vec![-1.0, -2.0, 3.0, -2.0, 3.0, 4.0, -1.0, 4.0],
            holes: Vec::new(),
        }]
    );
}

#[test]
fn a_single_closed_arc_forms_an_outline() {
    let mut edges = EdgeCuts::default();
    edges.open(Arc::from_center(point(2.0, 2.0), point(3.0, 2.0), 360.0).points());
    let outlines = edges.outlines(Bounds::EMPTY);
    assert_eq!(outlines.len(), 1);
    assert!(area(&outlines[0].outer) > 3.0);
}

#[test]
fn tiny_rings_keep_their_area_and_nesting_away_from_the_origin() {
    let mut edges = EdgeCuts::default();
    let square = |size: f64| {
        vec![
            point(1000.0 - size, 1000.0 - size),
            point(1000.0 + size, 1000.0 - size),
            point(1000.0 + size, 1000.0 + size),
            point(1000.0 - size, 1000.0 + size),
        ]
    };
    for size in [0.000002, 1.0, 0.1, 0.0001] {
        edges.closed(square(size));
    }
    let outlines = edges.outlines(Bounds::EMPTY);
    assert_eq!(outlines.len(), 2);
    assert_eq!(outlines[0].holes.len(), 1);
    assert_eq!(outlines[1].holes.len(), 1);
    assert!(area(&outlines[0].outer) > area(&outlines[1].outer));
    assert!(area(&outlines[1].outer) > 0.0);
    assert!(area(&outlines[1].holes[0]) < 0.0);
}
