use super::stroke::Stroke;
use super::{Board, Fields, child_point, points};
use crate::geometry::{Bounds, Point, Transform, point};
use crate::scene::{ItemInfo, ItemKind, Part, Pen};
use crate::sexpr::Expr;
use crate::text::{HAlign, TextStyle, VAlign, text_width};

const FIRST_EXPLICIT_BORDER: i64 = 20230825;
const ABSENT_STROKE: f64 = -0.000001;

type FootprintOwner<'f> = Option<(u32, &'f Fields)>;

impl Board {
    pub(super) fn textbox(&mut self, text: Expr, frame: &Transform, owner: FootprintOwner) {
        let Some(layer) = text.value("layer") else {
            return;
        };
        let Some(corners) = box_corners(text, frame) else {
            return;
        };
        let raw = raw_text(text);
        let shown = self.expand(&raw, owner.map(|(_, fields)| fields), &layer);
        let id = self.owner_item(owner, ItemKind::Text, &layer, Some(&shown));
        let pen = self.pen(id, &layer, Part::Main);
        let stroke = Stroke::from_expr(text, ABSENT_STROKE).scaled(frame);
        let border = if self.version < FIRST_EXPLICIT_BORDER {
            stroke.width >= 0.0
        } else {
            enabled(Some(text), "border")
        };
        let border_width = if border { stroke.width.max(0.0) } else { 0.0 };
        if border_width > 0.0 {
            stroke.closed(&mut self.scene, pen, &corners);
        }
        for p in corners {
            self.scene.include(id, p);
        }
        self.box_text(pen, text, &shown, &corners, frame, border_width);
    }

    fn owner_item(
        &mut self,
        owner: FootprintOwner,
        kind: ItemKind,
        layer: &str,
        text: Option<&str>,
    ) -> u32 {
        match owner {
            Some((footprint, _)) => footprint,
            None => self.scene.add_item(
                kind,
                ItemInfo {
                    layer: Some(layer.to_owned()),
                    text: text.map(Into::into),
                    ..ItemInfo::default()
                },
            ),
        }
    }

    fn box_text(
        &mut self,
        pen: Pen,
        text: Expr,
        shown: &str,
        corners: &[Point; 4],
        frame: &Transform,
        border_width: f64,
    ) {
        if text.flag("hide")
            || text
                .child("effects")
                .is_some_and(|effects| effects.flag("hide"))
        {
            return;
        }
        let degrees = box_angle(text, frame);
        let mut style = self.text_style(text, frame, degrees);
        if text.child("effects").is_none() {
            style.h_align = HAlign::Left;
        }
        let margins = margins(text, frame, &style);
        let anchor = text_anchor(corners, &margins, &style);
        // KiCad uses top/bottom margins for wrapping whenever the text is not horizontal.
        let margin_width = if degrees.rem_euclid(180.0).abs() < 1e-8 {
            margins[0] + margins[2]
        } else {
            margins[1] + margins[3]
        };
        let width = (corners[1] - corners[0]).length() - margin_width;
        let wrapped = wrap_text(shown, width, &style);
        self.draw_text(
            pen,
            text,
            &wrapped,
            anchor,
            &style,
            Some((corners, border_width)),
        );
    }

    pub(super) fn table(&mut self, table: Expr, frame: &Transform, owner: FootprintOwner) {
        let Some(layer) = table.value("layer") else {
            return;
        };
        let cells: Vec<_> = table
            .child("cells")
            .into_iter()
            .flat_map(|cells| cells.children_named("table_cell"))
            .collect();
        let columns = table.number_value("column_count").unwrap_or(0.0) as usize;
        if columns == 0 || cells.is_empty() || cells.len() % columns != 0 {
            return;
        }
        let rows = cells.len() / columns;
        // Saved cells already contain their laid-out, spanned geometry. KiCad's parser
        // does not normalize them from column_widths/row_heights on load.
        let corners: Option<Vec<_>> = cells.iter().map(|&cell| box_corners(cell, frame)).collect();
        let Some(corners) = corners else {
            return;
        };
        let id = self.owner_item(owner, ItemKind::Shape, &layer, None);
        let pen = self.pen(id, &layer, Part::Main);
        for (index, &cell) in cells.iter().enumerate() {
            for p in corners[index] {
                self.scene.include(id, p);
            }
            if span(cell, 0) == 0 || span(cell, 1) == 0 {
                continue;
            }
            let raw = raw_text(cell);
            let shown = self.expand(&raw, owner.map(|(_, fields)| fields), &layer);
            self.box_text(pen, cell, &shown, &corners[index], frame, 0.0);
        }
        let border = table.child("border");
        let separators = table.child("separators");
        let border_stroke = Stroke::from_expr(border.unwrap_or(table), ABSENT_STROKE).scaled(frame);
        let separator_stroke =
            Stroke::from_expr(separators.unwrap_or(table), ABSENT_STROKE).scaled(frame);
        let header = enabled(border, "header");
        for col in 0..columns.saturating_sub(1) {
            for row in 0..rows {
                let stroke = if row == 0 && header {
                    border_stroke
                } else if enabled(separators, "cols") {
                    separator_stroke
                } else {
                    continue;
                };
                let index = row * columns + col;
                let span = span(cells[index], 0);
                if span != 0 && col.saturating_add(span) < columns && stroke.width > 0.0 {
                    let [_, a, b, _] = corners[index];
                    stroke.line(&mut self.scene, pen, a, b);
                }
            }
        }
        for row in 0..rows.saturating_sub(1) {
            let stroke = if row == 0 && header {
                border_stroke
            } else if enabled(separators, "rows") {
                separator_stroke
            } else {
                continue;
            };
            for col in 0..columns {
                let index = row * columns + col;
                let span = span(cells[index], 1);
                if span != 0 && row.saturating_add(span) < rows && stroke.width > 0.0 {
                    let [_, _, a, b] = corners[index];
                    stroke.line(&mut self.scene, pen, a, b);
                }
            }
        }
        if enabled(border, "external") && border_stroke.width > 0.0 {
            let outline = [
                corners[0][0],
                corners[columns - 1][1],
                corners[cells.len() - 1][2],
                corners[(rows - 1) * columns][3],
            ];
            border_stroke.closed(&mut self.scene, pen, &outline);
        }
    }
}

fn raw_text<'a>(text: Expr<'_, 'a>) -> std::borrow::Cow<'a, str> {
    text.text_arg(usize::from(
        text.arg(0).and_then(Expr::atom) == Some("locked"),
    ))
    .unwrap_or_default()
}

fn enabled(item: Option<Expr>, name: &str) -> bool {
    item.is_none_or(|item| item.child(name).is_none() || item.flag(name))
}

fn span(cell: Expr, axis: usize) -> usize {
    cell.child("span")
        .and_then(|span| span.number_arg(axis))
        .unwrap_or(1.0) as usize
}

fn box_angle(text: Expr, frame: &Transform) -> f64 {
    (text.number_value("angle").unwrap_or(0.0) + frame.degrees()).rem_euclid(360.0)
}

fn box_corners(text: Expr, frame: &Transform) -> Option<[Point; 4]> {
    let degrees = box_angle(text, frame);
    if let Some(pts) = text.child("pts") {
        let mut bounds = Bounds::EMPTY;
        for p in points(pts) {
            bounds.include(frame.apply(p).rotated(-degrees), 0.0);
        }
        if bounds.is_empty() {
            return None;
        }
        return Some(rectangle(bounds.min, bounds.max).map(|p| p.rotated(degrees)));
    }
    let (a, b) = (child_point(text, "start")?, child_point(text, "end")?);
    let center = frame.apply((a + b) * 0.5);
    let scale = frame.scale();
    let half = point(((b.x - a.x) * scale.x).abs(), ((b.y - a.y) * scale.y).abs()) * 0.5;
    Some(rectangle(-half, half).map(|p| center + p.rotated(degrees)))
}

fn rectangle(a: Point, b: Point) -> [Point; 4] {
    [a, point(b.x, a.y), b, point(a.x, b.y)]
}

fn margins(text: Expr, frame: &Transform, style: &TextStyle) -> [f64; 4] {
    let legacy =
        frame.length(Stroke::from_expr(text, ABSENT_STROKE).width) / 2.0 + style.size.y * 0.75;
    let margins = text.child("margins");
    std::array::from_fn(|index| {
        margins
            .and_then(|margins| margins.number_arg(index))
            .map_or(legacy, |margin| frame.length(margin))
    })
}

fn text_anchor(corners: &[Point; 4], margins: &[f64; 4], style: &TextStyle) -> Point {
    let horizontal = match (style.h_align, style.mirrored) {
        (HAlign::Left, false) | (HAlign::Right, true) => 0.0,
        (HAlign::Right, false) | (HAlign::Left, true) => 1.0,
        (HAlign::Center, _) => 0.5,
    };
    let (vertical, dy) = match style.v_align {
        VAlign::Top => (0.0, margins[1]),
        VAlign::Center => (0.5, 0.0),
        VAlign::Bottom => (1.0, -margins[3]),
    };
    let dx = if horizontal == 0.0 {
        margins[0]
    } else if horizontal == 1.0 {
        -margins[2]
    } else {
        0.0
    };
    corners[0]
        + (corners[1] - corners[0]) * horizontal
        + (corners[3] - corners[0]) * vertical
        + point(dx, dy).rotated(style.degrees)
}

fn wrap_text(text: &str, width: f64, style: &TextStyle) -> String {
    let mut wrapped = String::with_capacity(text.len());
    let space_width = text_width(" ", style);
    for (index, line) in text.split('\n').enumerate() {
        if index != 0 {
            wrapped.push('\n');
        }
        let mut line_width = 0.0;
        let mut pending_spaces = 0;
        let mut bury_spaces = false;
        for word in words(line) {
            let trimmed = word.trim_end();
            let word_width = text_width(if trimmed.is_empty() { word } else { trimmed }, style);
            let mut pending_width = pending_spaces as f64 * space_width;
            if line_width + pending_width + word_width > width - style.pen_width
                && pending_spaces > 0
            {
                wrapped.push('\n');
                line_width = 0.0;
                pending_spaces = 0;
                pending_width = 0.0;
                bury_spaces = true;
            }
            if word == " " {
                pending_spaces += 1;
                continue;
            }
            if !bury_spaces {
                wrapped.extend(std::iter::repeat_n(' ', pending_spaces));
                line_width += pending_width;
            }
            bury_spaces = false;
            if let Some(word) = word.strip_suffix(' ') {
                wrapped.push_str(word);
                pending_spaces = 1;
            } else {
                wrapped.push_str(word);
                pending_spaces = 0;
            }
            line_width += word_width;
        }
    }
    wrapped
}

fn words(line: &str) -> Vec<&str> {
    let mut words = Vec::new();
    let mut start = 0;
    let mut depth = 0;
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if matches!(bytes[index], b'~' | b'_' | b'^') && bytes.get(index + 1) == Some(&b'{') {
            depth += 1;
            index += 2;
            continue;
        }
        if bytes[index] == b'}' && depth > 0 {
            depth -= 1;
        } else if bytes[index] == b' ' && depth == 0 {
            words.push(&line[start..=index]);
            start = index + 1;
        }
        index += 1;
    }
    if start < line.len() {
        words.push(&line[start..]);
    }
    words
}

#[cfg(test)]
mod tests;
