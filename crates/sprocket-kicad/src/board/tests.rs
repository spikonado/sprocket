use serde_json::Value;

use super::scene;

struct Decoded {
    meta: Value,
    layers: Vec<DecodedLayer>,
}

struct DecodedLayer {
    /// `name/part`, as in `F.Cu/main`.
    name: String,
    /// `[x1, y1, x2, y2, width]`
    segments: Vec<[f32; 5]>,
    /// `[cx, cy, radius, strokeWidth]`
    circles: Vec<[f32; 4]>,
    triangle_vertices: usize,
}

fn decode(src: &str) -> Decoded {
    let bytes = scene(src).unwrap();
    let word = |offset: usize| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    let float = |offset: usize| f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    let meta_len = word(8) as usize;
    let meta: Value = serde_json::from_slice(&bytes[12..12 + meta_len]).unwrap();
    let mut offset = 12 + meta_len.next_multiple_of(4);
    let mut layers = Vec::new();
    for layer in meta["layers"].as_array().unwrap() {
        let count = |key: &str| layer[key].as_u64().unwrap() as usize;
        let segments = (0..count("segments"))
            .map(|index| std::array::from_fn(|field| float(offset + index * 24 + field * 4)))
            .collect();
        offset += count("segments") * 24;
        let circles = (0..count("circles"))
            .map(|index| std::array::from_fn(|field| float(offset + index * 20 + field * 4)))
            .collect();
        offset += count("circles") * 20 + count("triangleVertices") * 12;
        layers.push(DecodedLayer {
            name: format!(
                "{}/{}",
                layer["name"].as_str().unwrap(),
                layer["part"].as_str().unwrap()
            ),
            segments,
            circles,
            triangle_vertices: count("triangleVertices"),
        });
    }
    assert_eq!(offset, bytes.len());
    Decoded { meta, layers }
}

fn close(a: f32, b: f64) -> bool {
    (f64::from(a) - b).abs() < 1e-4
}

#[test]
fn kicad_10_99_footprint_transform_places_pads_and_holes() {
    let board = decode(
        r#"(kicad_pcb (version 20261031)
            (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user))
            (net 1 "GND")
            (footprint "lib:R" (layer "F.Cu")
                (transform (translate 10 20) (rotate 90) (scale 2 2))
                (property "Reference" "R1" (at 0 0 90) (layer "F.Cu") (hide yes))
                (pad "1" thru_hole oval (at 1 0 90) (size 1 2) (drill 0.5)
                    (layers "*.Cu" "*.Mask") (net 1 "GND"))))"#,
    );
    let items = board.meta["items"].as_array().unwrap();
    assert_eq!(items[0]["reference"], "R1");
    assert_eq!(items[1]["parent"], 0);
    assert_eq!(items[1]["net"], 1);
    assert_eq!(board.meta["nets"], serde_json::json!(["", "GND"]));
    let position = items[1]["position"].as_array().unwrap();
    assert_eq!(
        (position[0].as_f64(), position[1].as_f64()),
        (Some(10.0), Some(18.0))
    );

    let names: Vec<&str> = board
        .layers
        .iter()
        .map(|layer| layer.name.as_str())
        .collect();
    assert_eq!(
        names,
        [
            "F.Cu/main",
            "B.Cu/main",
            "F.Mask/main",
            "B.Mask/main",
            "F.Cu/labels",
            "B.Cu/labels",
            "Holes/padWalls",
            "Holes/padHoles"
        ]
    );
    let [x1, y1, x2, y2, width] = board.layers[0].segments[0];
    // The pad's long axis is local y, turned 90° to board x, at twice the size.
    assert!(close(y1, 18.0) && close(y2, 18.0));
    assert!(close((x1 - x2).abs(), 2.0));
    assert!(close(width, 2.0));
    let wall = board.layers[6].circles[0];
    assert!(close(wall[2], 0.5 + 1.5 * 0.035));
    let hole = board.layers[7].circles[0];
    assert!(close(hole[0], 10.0) && close(hole[1], 18.0) && close(hole[2], 0.5));
}

#[test]
fn roundrect_pad_is_a_rect_with_a_rounding_stroke() {
    let board = decode(
        r#"(kicad_pcb (version 20241229)
            (layers (0 "F.Cu" signal))
            (footprint "lib:C" (layer "F.Cu") (at 0 0)
                (pad "1" smd roundrect (at 0 0) (size 2 1) (layers "F.Cu") (roundrect_rratio 0.25))))"#,
    );
    let layer = &board.layers[0];
    assert_eq!(layer.triangle_vertices, 6);
    assert_eq!(layer.segments.len(), 4);
    assert!(layer.segments.iter().all(|segment| close(segment[4], 0.5)));
    assert_eq!(
        board.meta["items"][1]["bbox"],
        serde_json::json!([-1.0, -0.5, 1.0, 0.5])
    );
}
