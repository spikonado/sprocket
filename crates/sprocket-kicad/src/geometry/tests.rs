use super::*;

#[test]
fn arc_through_three_points_keeps_its_direction() {
    let arc = Arc::through(point(1.0, 0.0), point(0.0, 1.0), point(-1.0, 0.0)).unwrap();
    assert!((arc.radius - 1.0).abs() < 1e-9);
    assert!((arc.sweep - PI).abs() < 1e-9);
    let points = arc.points();
    let middle = points[points.len() / 2];
    assert!((middle - point(0.0, 1.0)).length() < MAX_CHORD_ERROR);
    assert!(points.windows(2).all(|pair| {
        let mid = (pair[0] + pair[1]) * 0.5;
        1.0 - mid.length() <= MAX_CHORD_ERROR + 1e-9
    }));
}

#[test]
fn transform_rotates_like_kicad() {
    let frame = Transform::new(point(10.0, 0.0), 90.0, point(1.0, 1.0));
    let moved = frame.apply(point(1.0, 0.0));
    assert!((moved - point(10.0, -1.0)).length() < 1e-9);
}
