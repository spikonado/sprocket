use serde_json::Value;

use super::super::test_support;
use super::*;

fn decode(items: &str) -> (Value, Vec<[f32; 5]>) {
    let board = test_support::decode(&format!("(kicad_pcb (version 20261031) {items})"));
    (
        board.meta,
        board
            .layers
            .into_iter()
            .flat_map(|layer| layer.segments)
            .collect(),
    )
}

fn style() -> TextStyle {
    TextStyle {
        size: point(1.0, 1.0),
        pen_width: 0.15,
        degrees: 0.0,
        mirrored: false,
        italic: false,
        h_align: HAlign::Left,
        v_align: VAlign::Top,
        line_spacing: 1.0,
    }
}

#[test]
fn rectangle_rotation_matches_kicad_svg_probe() {
    let (meta, segments) = decode(
        r#"(gr_text_box "ROT90 box" (start 10 10) (end 20 14)
            (angle 90) (margins 0.5 0.5 0.5 0.5) (layer "F.SilkS")
            (effects (font (size 1 1) (thickness 0.15)) (justify left top))
            (border yes) (stroke (width 0.2) (type solid)))"#,
    );
    assert_eq!(
        &segments[..4],
        &[
            [13.0, 17.0, 13.0, 7.0, 0.2],
            [13.0, 7.0, 17.0, 7.0, 0.2],
            [17.0, 7.0, 17.0, 17.0, 0.2],
            [17.0, 17.0, 13.0, 17.0, 0.2],
        ]
    );
    assert_eq!(meta["items"][0]["kind"], "text");
    assert_eq!(meta["items"][0]["text"], "ROT90 box");
    let [x, y, _, _, _] = segments[4];
    assert!((x - 14.5398).abs() < 0.001 && (y - 15.5918).abs() < 0.001);
}

#[test]
fn polygon_corners_are_already_rotated_and_footprint_fields_expand() {
    let (meta, segments) = decode(
        r#"(footprint "lib:Box" (layer "F.Cu")
            (transform (translate 20 30) (rotate 90) (scale 1 1))
            (property "Reference" "U1" (at 0 0) (layer "F.SilkS") (hide yes))
            (fp_text_box "${REFERENCE}" (pts (xy 0 0) (xy 0 -10) (xy 4 -10) (xy 4 0))
                (angle 90) (margins 0 0 0 0) (layer "F.SilkS")
                (effects (font (size 1 1) (thickness 0.15)) (justify left top))
                (border yes) (stroke (width 0.2) (type solid))))"#,
    );
    assert_eq!(
        &segments[..4],
        &[
            [20.0, 30.0, 10.0, 30.0, 0.2],
            [10.0, 30.0, 10.0, 26.0, 0.2],
            [10.0, 26.0, 20.0, 26.0, 0.2],
            [20.0, 26.0, 20.0, 30.0, 0.2],
        ]
    );
    assert_eq!(meta["items"].as_array().unwrap().len(), 1);
    assert!(segments.len() > 4);
}

#[test]
fn knockout_fills_the_whole_box_for_both_flag_locations() {
    for (layer_flag, text_flag) in [("knockout", ""), ("", "(knockout yes)")] {
        let board = test_support::decode(&format!(
            r#"(kicad_pcb (version 20261031)
                (gr_text_box "H" (start 0 0) (end 10 6) (margins 0 0 0 0)
                    (layer "F.SilkS" {layer_flag}) {text_flag} (border no)
                    (effects (font (size 1 1) (thickness 0.15)) (justify left top))))"#
        ));
        let layer = &board.layers[0];
        assert!(test_support::covers(layer, [9.0, 5.0]));
        assert!(layer.segments.is_empty());
    }
}

#[test]
fn wrapping_uses_font_advances_and_keeps_markup_and_long_words_intact() {
    let style = style();
    let width = text_width("one two", &style) + style.pen_width + 0.001;
    assert_eq!(wrap_text("one two three", width, &style), "one two\nthree");
    assert_eq!(wrap_text("one\n\nthree\n", width, &style), "one\n\nthree\n");
    assert_eq!(wrap_text("one\n\n", width, &style), "one\n\n");
    assert_eq!(wrap_text("overlong", 0.1, &style), "overlong");
    assert_eq!(words("a~{b c} d^{e f} g"), ["a~{b c} ", "d^{e f} ", "g"]);
    assert_eq!(
        wrap_text("~{one two} three", 0.1, &style),
        "~{one two}\nthree"
    );
}

#[test]
fn anchor_uses_only_the_justified_margins_and_swaps_mirrored_sides() {
    let corners = rectangle(point(0.0, 0.0), point(10.0, 6.0));
    let margins = [1.0, 2.0, 3.0, 4.0];
    let style = style();
    assert_eq!(text_anchor(&corners, &margins, &style), point(1.0, 2.0));
    assert_eq!(
        text_anchor(
            &corners,
            &margins,
            &TextStyle {
                mirrored: true,
                ..style
            }
        ),
        point(7.0, 2.0)
    );
    assert_eq!(
        text_anchor(
            &corners,
            &margins,
            &TextStyle {
                h_align: HAlign::Center,
                v_align: VAlign::Center,
                ..style
            }
        ),
        point(5.0, 3.0)
    );
}

#[test]
fn table_borders_follow_spanned_cells_and_header_strokes() {
    let (meta, segments) = decode(
        r#"(table (column_count 3) (layer "F.SilkS")
            (column_widths 10 10 10) (row_heights 4 4 4)
            (border (external yes) (header yes) (stroke (width 0.4) (type solid)))
            (separators (rows yes) (cols yes) (stroke (width 0.1) (type solid)))
            (cells
                (table_cell "" (start 0 0) (end 20 4) (span 2 1))
                (table_cell "covered" (start 10 0) (end 20 4) (span 0 0))
                (table_cell "" (start 20 0) (end 30 4) (span 1 1))
                (table_cell "" (start 0 4) (end 10 12) (span 1 2))
                (table_cell "" (start 10 4) (end 20 8) (span 1 1))
                (table_cell "" (start 20 4) (end 30 8) (span 1 1))
                (table_cell "covered" (start 0 8) (end 10 12) (span 0 0))
                (table_cell "" (start 10 8) (end 20 12) (span 1 1))
                (table_cell "" (start 20 8) (end 30 12) (span 1 1))))"#,
    );
    assert_eq!(
        segments,
        [
            [20.0, 0.0, 20.0, 4.0, 0.4],
            [10.0, 4.0, 10.0, 12.0, 0.1],
            [20.0, 4.0, 20.0, 8.0, 0.1],
            [20.0, 8.0, 20.0, 12.0, 0.1],
            [20.0, 4.0, 0.0, 4.0, 0.4],
            [30.0, 4.0, 20.0, 4.0, 0.4],
            [20.0, 8.0, 10.0, 8.0, 0.1],
            [30.0, 8.0, 20.0, 8.0, 0.1],
            [0.0, 0.0, 30.0, 0.0, 0.4],
            [30.0, 0.0, 30.0, 12.0, 0.4],
            [30.0, 12.0, 0.0, 12.0, 0.4],
            [0.0, 12.0, 0.0, 0.0, 0.4],
        ]
    );
    assert_eq!(meta["items"].as_array().unwrap().len(), 1);
    assert_eq!(meta["items"][0]["kind"], "shape");
    assert_eq!(
        meta["items"][0]["bbox"],
        serde_json::json!([-0.2, -0.2, 30.2, 12.2])
    );
}
