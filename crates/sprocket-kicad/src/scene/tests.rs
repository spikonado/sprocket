use super::*;
use crate::geometry::point;

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

#[test]
fn encodes_nonempty_layer_parts_with_aligned_buffers() {
    let mut scene = Scene::new();
    let item = scene.add_item(ItemKind::Shape, ItemInfo::default());
    let front = Pen {
        item,
        layer: scene.layer("F.SilkS", Part::Main),
    };
    let back = Pen {
        item,
        layer: scene.layer("B.Cu", Part::Zones),
    };
    scene.layer("In1.Cu", Part::Main);
    scene.segment(front, point(0.0, 0.0), point(1.0, 0.0), 0.5);
    scene.circle(back, point(2.0, 2.0), 1.0, 0.0);
    let bytes = scene.encode();

    assert_eq!(&bytes[..4], b"SPKS");
    assert_eq!(u32_at(&bytes, 4), FORMAT_VERSION);
    let meta_len = u32_at(&bytes, 8) as usize;
    let meta: serde_json::Value = serde_json::from_slice(&bytes[12..12 + meta_len]).unwrap();
    let names: Vec<(&str, &str)> = meta["layers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|layer| {
            (
                layer["name"].as_str().unwrap(),
                layer["part"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(names, [("F.SilkS", "main"), ("B.Cu", "zones")]);
    assert_eq!(
        meta["items"][0]["bbox"],
        serde_json::json!([-0.25, -0.25, 3.0, 3.0])
    );
    assert_eq!(meta["nets"], serde_json::json!([""]));

    let buffers = 12 + meta_len.next_multiple_of(4);
    assert_eq!(bytes.len(), buffers + SEGMENT_BYTES + CIRCLE_BYTES);
    let circle = buffers + SEGMENT_BYTES;
    let radius = f32::from_le_bytes(bytes[circle + 8..circle + 12].try_into().unwrap());
    assert_eq!(radius, 1.0);
}

#[test]
fn large_polygons_split_without_losing_area() {
    const TEETH: usize = 300;
    let width = 2.0 * TEETH as f64;
    let mut comb = vec![point(0.0, 0.0), point(width, 0.0), point(width, 1.0)];
    for tooth in (0..TEETH).rev() {
        let x = 2.0 * tooth as f64;
        comb.extend([
            point(x + 1.0, 1.0),
            point(x + 1.0, 10.0),
            point(x, 10.0),
            point(x, 1.0),
        ]);
    }
    let mut scene = Scene::new();
    let item = scene.add_item(ItemKind::Zone, ItemInfo::default());
    let pen = Pen {
        item,
        layer: scene.layer("F.Cu", Part::Zones),
    };
    scene.polygon(pen, &comb, &[]);

    let area: f64 = scene.layers[0]
        .triangles
        .as_chunks::<VERTEX_BYTES>()
        .0
        .iter()
        .map(|vertex| {
            let x = f32::from_le_bytes(vertex[0..4].try_into().unwrap());
            let y = f32::from_le_bytes(vertex[4..8].try_into().unwrap());
            point(f64::from(x), f64::from(y))
        })
        .collect::<Vec<_>>()
        .as_chunks::<3>()
        .0
        .iter()
        .map(|t| {
            ((t[1].x - t[0].x) * (t[2].y - t[0].y) - (t[2].x - t[0].x) * (t[1].y - t[0].y)).abs()
                / 2.0
        })
        .sum();
    assert!((area - 11.0 * TEETH as f64).abs() < 1e-6, "area {area}");
}

fn polygon_area(polygons: &[Vec<Vec<Point>>]) -> f64 {
    polygons
        .iter()
        .map(|polygon| {
            polygon
                .iter()
                .enumerate()
                .map(|(index, ring)| {
                    let area = ring
                        .iter()
                        .zip(ring.iter().cycle().skip(1))
                        .map(|(a, b)| a.x * b.y - a.y * b.x)
                        .sum::<f64>()
                        .abs()
                        / 2.0;
                    if index == 0 { area } else { -area }
                })
                .sum::<f64>()
        })
        .sum()
}

#[test]
fn offsets_polygon_union_before_eroding() {
    let mut scene = Scene::new();
    let pen = Pen {
        item: scene.add_item(ItemKind::Pad, ItemInfo::default()),
        layer: scene.layer("F.Paste", Part::Main),
    };
    for (left, right) in [(-2.0, 0.5), (-0.5, 2.0)] {
        scene.polygon(
            pen,
            &[
                point(left, -1.0),
                point(right, -1.0),
                point(right, 1.0),
                point(left, 1.0),
            ],
            &[],
        );
    }
    let polygons = scene.offset_polygons(-0.75);
    assert_eq!(polygons.len(), 1);
    assert!((polygon_area(&polygons) - 1.25).abs() < 1e-6);
}

#[test]
fn offsets_round_caps_and_filled_circles() {
    let mut scene = Scene::new();
    let pen = Pen {
        item: scene.add_item(ItemKind::Pad, ItemInfo::default()),
        layer: scene.layer("F.Mask", Part::Main),
    };
    scene.segment(pen, point(-1.0, 0.0), point(1.0, 0.0), 2.0);
    scene.circle(pen, point(-1.0, 0.0), 1.0, 0.0);
    let polygons = scene.offset_polygons(0.5);
    assert_eq!(polygons.len(), 1);
    let expected = 6.0 + std::f64::consts::PI * 1.5_f64.powi(2);
    assert!((polygon_area(&polygons) - expected).abs() < 0.1);
}

#[test]
fn offsets_ring_holes_and_erodes_away_thin_shapes() {
    let mut scene = Scene::new();
    let pen = Pen {
        item: scene.add_item(ItemKind::Pad, ItemInfo::default()),
        layer: scene.layer("F.Paste", Part::Main),
    };
    scene.circle(pen, point(0.0, 0.0), 2.0, 2.0);
    let polygons = scene.offset_polygons(-0.25);
    assert_eq!(polygons.len(), 1);
    assert_eq!(polygons[0].len(), 2);
    let expected = std::f64::consts::PI * (2.75_f64.powi(2) - 1.25_f64.powi(2));
    assert!((polygon_area(&polygons) - expected).abs() < 0.15);
    assert!(scene.offset_polygons(-1.1).is_empty());
}
