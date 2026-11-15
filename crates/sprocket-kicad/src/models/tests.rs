use crate::{pcb_models_board, pcb_scene};

const BOARD: &str = r#"(kicad_pcb (version 20241229) (generator "pcbnew")
    (general (thickness 1.6))
    (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
    (setup (pad_to_mask_clearance 0))
    (net 0 "")
    (footprint "lib:R" (layer "F.Cu") (uuid "a") (at 10 20 90)
        (property "Reference" "R1" (at 0 0) (layer "F.SilkS") (effects (font (size 1 1))))
        (property "Value" "10k" (at 0 0) (layer "F.Fab"))
        (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))
        (model "${KICAD10_3DMODEL_DIR}/R.3dshapes/R.wrl" (offset (xyz 0 0 1)))
        (model "3d/part.WRL")
        (model "kicad-embed://part.step"))
    (footprint "lib:MountingHole" (layer "F.Cu") (at 0 0))
    (gr_line (start 0 0) (end 10 0) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)))
    (gr_line (start 0 0) (end 10 0) (layer "F.SilkS"))
    (segment (start 0 0) (end 1 1) (width 0.2) (layer "F.Cu") (net 0)))"#;

fn key(board: &str) -> Option<String> {
    pcb_models_board(board.as_bytes())
        .unwrap()
        .map(|board| board.key)
}

#[test]
fn keeps_only_what_places_models() {
    let board = pcb_models_board(BOARD.as_bytes()).unwrap().unwrap();
    assert_eq!(
        board.text_in(r#"/boards/a "b""#),
        r#"(kicad_pcb
  (version 20241229)
  (generator "pcbnew")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (footprint "lib:R"
    (layer "F.Cu")
    (at 10 20 90)
    (property "Reference" "R1")
    (model "${KICAD10_3DMODEL_DIR}/R.3dshapes/R.step" (offset (xyz 0 0 1)))
    (model "/boards/a \"b\"/3d/part.step")
    (model "kicad-embed://part.step")
  )
  (gr_line (start 0 0) (end 10 0) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)))
)
"#
    );

    let scene = pcb_scene(BOARD.as_bytes()).unwrap();
    let meta_len = u32::from_le_bytes(scene[8..12].try_into().unwrap()) as usize;
    let meta: serde_json::Value = serde_json::from_slice(&scene[12..12 + meta_len]).unwrap();
    assert_eq!(meta["models"].as_str(), Some(board.key.as_str()));
}

#[test]
fn key_follows_footprints_and_not_routing() {
    let original = key(BOARD);
    assert!(original.is_some());
    let rerouted = BOARD.replace("(end 1 1) (width 0.2)", "(end 2 3) (width 0.3)");
    assert_eq!(key(&rerouted), original);
    let moved = BOARD.replace("(at 10 20 90)", "(at 11 20 90)");
    assert_ne!(key(&moved), original);
}

#[test]
fn boards_without_models_have_no_key() {
    let board = r#"(kicad_pcb (version 20241229) (footprint "lib:R" (layer "F.Cu") (at 0 0)))"#;
    assert_eq!(key(board), None);
}

#[test]
fn model_paths_resolve_from_the_original_board() {
    for (input, expected) in [
        ("part.WrL", "${KIPRJMOD}/part.step"),
        ("../part.step", "${KIPRJMOD}/../part.step"),
        ("${LIB}/part.wrl", "${LIB}/part.step"),
        ("/models/part.wrl", "/models/part.step"),
        (r"C:\models\part.wrl", r"C:\models\part.step"),
        ("kicad-embed://part.step", "kicad-embed://part.step"),
        ("ALIAS:part.wrl", "ALIAS:part.step"),
    ] {
        assert_eq!(super::export_path(input), expected);
    }
}
