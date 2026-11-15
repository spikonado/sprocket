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
    triangles: Vec<[f32; 2]>,
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
        offset += count("circles") * 20;
        let triangles = (0..count("triangleVertices"))
            .map(|index| std::array::from_fn(|field| float(offset + index * 12 + field * 4)))
            .collect();
        offset += count("triangleVertices") * 12;
        layers.push(DecodedLayer {
            name: format!(
                "{}/{}",
                layer["name"].as_str().unwrap(),
                layer["part"].as_str().unwrap()
            ),
            segments,
            circles,
            triangle_vertices: count("triangleVertices"),
            triangles,
        });
    }
    assert_eq!(offset, bytes.len());
    Decoded { meta, layers }
}

impl Decoded {
    fn layer(&self, name: &str) -> &DecodedLayer {
        self.layers.iter().find(|layer| layer.name == name).unwrap()
    }
}

impl DecodedLayer {
    fn bounds(&self) -> [f64; 4] {
        let mut bounds = crate::geometry::Bounds::EMPTY;
        for &[x1, y1, x2, y2, width] in &self.segments {
            bounds.include(crate::geometry::point(x1.into(), y1.into()), f64::from(width) / 2.0);
            bounds.include(crate::geometry::point(x2.into(), y2.into()), f64::from(width) / 2.0);
        }
        for &[x, y, radius, stroke] in &self.circles {
            bounds.include(crate::geometry::point(x.into(), y.into()), f64::from(radius + stroke / 2.0));
        }
        for &[x, y] in &self.triangles {
            bounds.include(crate::geometry::point(x.into(), y.into()), 0.0);
        }
        [bounds.min.x, bounds.min.y, bounds.max.x, bounds.max.y]
    }
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

#[test]
fn via_flashing_uses_same_net_tracks_in_either_file_order_and_saved_zone_connections() {
    let via = r#"(via (at 0 0) (size 1) (drill 0.4) (layers "F.Cu" "B.Cu")
        (remove_unused_layers yes) (keep_end_layers yes) (zone_layer_connections "In2.Cu") (net 1))"#;
    let tracks = r#"
        (segment (start 0 0) (end 2 0) (width 0.2) (layer "In1.Cu") (net 1))
        (segment (start 0 0) (end 2 0) (width 0.2) (layer "In3.Cu") (net 2))"#;
    for items in [format!("{via}{tracks}"), format!("{tracks}{via}")] {
        let board = decode(&format!(r#"(kicad_pcb
            (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal)
                (8 "In3.Cu" signal) (2 "B.Cu" signal))
            (net 1 "A") (net 2 "B") {items})"#));
        for layer in ["F.Cu/main", "In1.Cu/main", "In2.Cu/main", "B.Cu/main"] {
            assert!(close(board.layer(layer).circles[0][2], 0.5), "{layer}");
        }
        assert!(board.layer("In3.Cu/main").circles.is_empty());
    }
}

#[test]
fn blind_via_keeps_its_own_ends_and_can_remove_both_ends() {
    for (keep, expected) in [("yes", vec!["In1.Cu/main", "In3.Cu/main"]), ("no", vec![])] {
        let board = decode(&format!(r#"(kicad_pcb
            (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal)
                (8 "In3.Cu" signal) (2 "B.Cu" signal))
            (via blind (at 0 0) (size 1) (drill 0.4) (layers "In1.Cu" "In3.Cu")
                (remove_unused_layers yes) (keep_end_layers {keep})))"#));
        let copper: Vec<&str> = board.layers.iter().filter(|layer| layer.name.ends_with("Cu/main"))
            .map(|layer| layer.name.as_str()).collect();
        assert_eq!(copper, expected);
    }
}

#[test]
fn through_hole_pad_flashing_preserves_mask_paste_and_drill_and_uses_arc_connections() {
    let board = decode(r#"(kicad_pcb
        (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal))
        (net 1 "A")
        (footprint "P" (layer "F.Cu") (at 10 20)
            (pad "1" thru_hole oval (at 1 0 90) (size 2 1) (drill oval 1 0.5)
                (layers "*.Cu" "*.Mask" "F.Paste") (solder_paste_margin -0.1)
                (remove_unused_layers yes) (keep_end_layers no)
                (zone_layer_connections "In1.Cu") (net 1 "A")))
        (arc (start 11 20) (mid 12 19) (end 13 20) (width 0.2) (layer "In2.Cu") (net 1)))"#);
    let names: Vec<&str> = board.layers.iter().map(|layer| layer.name.as_str()).collect();
    for expected in [
        "In1.Cu/main",
        "In2.Cu/main",
        "F.Mask/main",
        "B.Mask/main",
        "F.Paste/main",
        "Holes/padHoles",
    ] {
        assert!(names.contains(&expected), "{names:?}");
    }
    assert!(!names.contains(&"F.Cu/main") && !names.contains(&"B.Cu/main"));
    assert!(close(board.layer("F.Paste/main").segments[0][4], 0.8));
    let hole = board.layer("Holes/padHoles").segments[0];
    assert!(close(hole[0], 11.0) && close(hole[2], 11.0));
    assert!(close(hole[1], 20.25) && close(hole[3], 19.75));
}

#[test]
fn padstacks_select_layer_shapes_and_offsets_without_moving_drills() {
    let board = decode(r#"(kicad_pcb
        (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal))
        (footprint "P" (layer "F.Cu")
            (pad "1" thru_hole circle (size 2 2) (drill 0.5) (layers "*.Cu" "*.Mask")
                (padstack (mode front_inner_back)
                    (layer "Inner" (shape rect) (size 3 1) (offset 0.5 0))
                    (layer "B.Cu" (shape oval) (size 1 2)))))
        (via (at 10 0) (size 2) (drill 0.5) (layers "F.Cu" "B.Cu")
            (padstack (mode custom) (layer "In1.Cu" (size 1)) (layer "B.Cu" (size 3)))))"#);
    assert!(close(board.layer("F.Cu/main").circles[0][2], 1.0));
    assert!(close(board.layer("In1.Cu/main").circles[0][2], 0.5));
    assert!(close(board.layer("In2.Cu/main").circles[0][2], 1.0));
    assert!(close(board.layer("B.Cu/main").circles[0][2], 1.5));
    let inner = &board.layer("In1.Cu/main").triangles;
    assert!(inner.iter().any(|p| close(p[0], -1.0)));
    assert!(inner.iter().any(|p| close(p[0], 2.0)));
    let back = board.layer("B.Cu/main").segments[0];
    assert!(close(back[4], 1.0) && close((back[3] - back[1]).abs(), 1.0));
    let mask = board.layer("B.Mask/main").segments[0];
    assert_eq!(back, mask);
    let hole = board.layer("Holes/padHoles").circles[0];
    assert!(close(hole[0], 0.0) && close(hole[1], 0.0));
}

#[test]
fn mask_and_paste_margins_inherit_independently_and_legacy_zero_inherits() {
    for (version, expected_mask, expected_paste) in [(20240201, 1.2, 0.85), (20241229, 1.0, 0.95)] {
        let board = decode(&format!(r#"(kicad_pcb (version {version}) (layers (0 "F.Cu" signal))
            (setup (pad_to_mask_clearance 0.1) (pad_to_paste_clearance -0.05)
                (pad_to_paste_clearance_ratio -0.1))
            (footprint "P" (layer "F.Cu") (solder_mask_margin 0.2) (solder_paste_margin_ratio -0.05)
                (pad "1" smd circle (size 2 2) (layers "F.Cu" "F.Mask" "F.Paste")
                    (solder_mask_margin 0) (solder_paste_margin_ratio 0))))"#));
        assert!(close(board.layer("F.Mask/main").circles[0][2], expected_mask));
        assert!(close(board.layer("F.Paste/main").circles[0][2], expected_paste));
        assert!(close(board.layer("F.Cu/main").circles[0][2], 1.0));
    }
}

#[test]
fn paste_ratio_resizes_each_axis_and_preserves_roundrect_radius_ratio() {
    let board = decode(r#"(kicad_pcb (version 20241229) (layers (0 "F.Cu" signal))
        (footprint "P" (layer "F.Cu")
            (pad "1" smd roundrect (size 2 1) (roundrect_rratio 0.25)
                (layers "F.Cu" "F.Mask" "F.Paste") (solder_mask_margin 0.1)
                (solder_paste_margin -0.02) (solder_paste_margin_ratio -0.2))))"#);
    let mask = board.layer("F.Mask/main");
    let paste = board.layer("F.Paste/main");
    for (a, b) in mask.bounds().into_iter().zip([-1.1, -0.6, 1.1, 0.6]) {
        assert!((a - b).abs() < 1e-5);
    }
    for (a, b) in paste.bounds().into_iter().zip([-0.58, -0.28, 0.58, 0.28]) {
        assert!((a - b).abs() < 1e-5);
    }
    assert!(mask.segments.iter().all(|s| close(s[4], 0.7)));
    assert!(paste.segments.iter().all(|s| close(s[4], 0.28)));
}

#[test]
fn chamfered_roundrect_keeps_chamfers_sharp_and_scales_shrinking_apertures() {
    let board = decode(r#"(kicad_pcb (version 20250324) (layers (0 "F.Cu" signal))
        (footprint "P" (layer "F.Cu")
            (pad "1" smd roundrect (size 2 2) (roundrect_rratio 0.1)
                (chamfer_ratio 0.3) (chamfer top_left bottom_right)
                (layers "F.Cu" "F.Mask" "F.Paste") (solder_mask_margin -0.1)
                (solder_paste_margin -0.02) (solder_paste_margin_ratio -0.2))))"#);
    for (name, half, chamfer, radius) in [
        ("F.Cu/main", 1.0, 0.6, 0.2),
        ("F.Mask/main", 0.9, 0.54, 0.18),
        ("F.Paste/main", 0.58, 0.348, 0.116),
    ] {
        let layer = board.layer(name);
        for (x, y) in [
            (-half, -half + chamfer),
            (-half + chamfer, -half),
            (half, half - chamfer),
            (half - chamfer, half),
            (half - radius, -half),
            (half, -half + radius),
            (-half + radius, half),
            (-half, half - radius),
        ] {
            assert!(
                layer.triangles.iter().any(|p| close(p[0], x) && close(p[1], y)),
                "{name} missing boundary vertex ({x}, {y})"
            );
        }
    }
}

#[test]
fn trapezoid_paste_insets_the_sloped_edges_without_reversing_delta() {
    let board = decode(r#"(kicad_pcb (version 20250324) (layers (0 "F.Cu" signal))
        (footprint "P" (layer "F.Cu")
            (pad "1" smd trapezoid (size 2 1.5) (rect_delta 0.5 0)
                (layers "F.Cu" "F.Paste")
                (solder_paste_margin -0.02) (solder_paste_margin_ratio -0.2))))"#);
    for (name, corners) in [
        (
            "F.Cu/main",
            [(-1.0, -1.0), (1.0, -0.5), (1.0, 0.5), (-1.0, 1.0)],
        ),
        (
            "F.Paste/main",
            [
                (-0.58, -0.4621),
                (0.58, -0.1721),
                (0.58, 0.1721),
                (-0.58, 0.4621),
            ],
        ),
    ] {
        let layer = board.layer(name);
        for (x, y) in corners {
            assert!(
                layer.triangles.iter().any(|p| close(p[0], x) && close(p[1], y)),
                "{name} missing boundary vertex ({x}, {y})"
            );
        }
    }
}

#[test]
fn mask_only_pads_keep_their_defined_size_and_empty_paste_openings_disappear() {
    let board = decode(r#"(kicad_pcb (layers (0 "F.Cu" signal))
        (setup (pad_to_mask_clearance 0.2))
        (footprint "P" (layer "F.Cu")
            (pad "" smd circle (size 2 2) (layers "F.Mask"))
            (pad "1" smd rect (size 2 1) (layers "F.Cu" "F.Paste") (solder_paste_margin -1))))"#);
    assert!(close(board.layer("F.Mask/main").circles[0][2], 1.0));
    assert!(!board.layers.iter().any(|layer| layer.name == "F.Paste/main"));
}

#[test]
fn via_mask_openings_use_board_defaults_and_side_overrides_and_outer_padstack_sizes() {
    let board = decode(r#"(kicad_pcb (version 20250324)
        (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (2 "B.Cu" signal))
        (setup (pad_to_mask_clearance 0.1) (tenting (front no) (back yes)))
        (via (at 0 0) (size 1) (drill 0.4) (layers "F.Cu" "B.Cu"))
        (via (at 3 0) (size 1) (drill 0.4) (layers "F.Cu" "B.Cu")
            (tenting (front yes) (back no))
            (padstack (mode front_inner_back) (layer "Inner" (size 0.6)) (layer "B.Cu" (size 1.4))))
        (via blind (at 6 0) (size 1) (drill 0.4) (layers "F.Cu" "In1.Cu")
            (tenting (front none) (back no))))"#);
    let front = &board.layer("F.Mask/main").circles;
    assert_eq!(front.len(), 2);
    assert!(close(front[0][0], 0.0) && close(front[1][0], 6.0));
    assert!(front.iter().all(|c| close(c[2], 0.6)));
    let back = &board.layer("B.Mask/main").circles;
    assert_eq!(back.len(), 1);
    assert!(close(back[0][0], 3.0) && close(back[0][2], 0.8));
}

#[test]
fn legacy_vias_default_to_tented_and_respect_legacy_plot_setting() {
    for (setting, open) in [("", false), ("(pcbplotparams (viasonmask true))", true)] {
        let board = decode(&format!(r#"(kicad_pcb (version 20221018)
            (layers (0 "F.Cu" signal) (2 "B.Cu" signal)) (setup {setting})
            (via (at 0 0) (size 1) (drill 0.4) (layers "F.Cu" "B.Cu")))"#));
        assert_eq!(board.layers.iter().any(|layer| layer.name == "F.Mask/main"), open);
        assert_eq!(board.layers.iter().any(|layer| layer.name == "B.Mask/main"), open);
    }
}
