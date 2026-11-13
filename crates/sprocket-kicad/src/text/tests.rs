use super::*;

fn style(h_align: HAlign) -> TextStyle {
    TextStyle {
        size: point(1.0, 1.0),
        pen_width: 0.1,
        degrees: 0.0,
        mirrored: false,
        italic: false,
        h_align,
        v_align: VAlign::Center,
        line_spacing: 1.0,
    }
}

fn x_range(strokes: &[Vec<Point>]) -> (f64, f64) {
    let xs = strokes.iter().flatten().map(|p| p.x);
    (
        xs.clone().fold(f64::INFINITY, f64::min),
        xs.fold(f64::NEG_INFINITY, f64::max),
    )
}

#[test]
fn alignment_places_text_around_the_anchor() {
    let (left, _) = x_range(&stroke_text("H", Point::default(), &style(HAlign::Left)));
    let (_, right) = x_range(&stroke_text("H", Point::default(), &style(HAlign::Right)));
    let (center_min, center_max) =
        x_range(&stroke_text("H", Point::default(), &style(HAlign::Center)));
    assert!(left > 0.0);
    assert!(right < 0.0);
    assert!((center_min + center_max).abs() < 0.2);
}

#[test]
fn a_trailing_newline_lays_out_like_kicad() {
    let style = style(HAlign::Left);
    assert_eq!(
        stroke_text("A\n", Point::default(), &style),
        stroke_text("A", Point::default(), &style)
    );
}

#[test]
fn overbar_adds_one_stroke_above_the_glyphs() {
    let plain = stroke_text("A", Point::default(), &style(HAlign::Left));
    let barred = stroke_text("~{A}", Point::default(), &style(HAlign::Left));
    assert_eq!(barred.len(), plain.len() + 1);
    let top = plain
        .iter()
        .flatten()
        .map(|p| p.y)
        .fold(f64::INFINITY, f64::min);
    assert!(
        barred
            .iter()
            .any(|stroke| stroke.len() == 2 && stroke[0].y < top)
    );
}

#[test]
fn deeply_nested_markup_still_lays_out() {
    let text = format!("{}A", "~{".repeat(100_000));
    assert!(!stroke_text(&text, Point::default(), &style(HAlign::Left)).is_empty());
}
