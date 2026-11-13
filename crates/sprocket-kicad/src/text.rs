//! KiCad's stroke font and text layout, after `common/font/stroke_font.cpp` and
//! `common/font/font.cpp`.

use std::sync::OnceLock;

use crate::geometry::{Point, point};

/// Newstroke glyphs from U+0020 up to the CJK ideographs, one per line.
const NEWSTROKE: &str = include_str!("text/newstroke.txt");
const FONT_SCALE: f64 = 1.0 / 21.0;
const FONT_OFFSET: i32 = -8;
const ITALIC_TILT: f64 = 1.0 / 8.0;
const TAB_WIDTH: usize = 4;
const SUPER_SUB_SIZE: f64 = 0.8;
const SUBSCRIPT_OFFSET: f64 = 0.15;
const SUPERSCRIPT_OFFSET: f64 = -0.35;
const INTERLINE_PITCH: f64 = 1.68 * 0.9583;
const OVERBAR_HEIGHT: f64 = 1.23;
const BOLD_STROKE_MULTIPLIER: f64 = 1.6;

struct Glyph {
    width: f64,
    strokes: Vec<Vec<Point>>,
}

fn glyphs() -> &'static [Glyph] {
    static GLYPHS: OnceLock<Vec<Glyph>> = OnceLock::new();
    GLYPHS.get_or_init(|| NEWSTROKE.lines().map(decode_glyph).collect())
}

fn decode_glyph(data: &str) -> Glyph {
    let coordinate = |byte: u8| i32::from(byte) - i32::from(b'R');
    let mut glyph = Glyph {
        width: 0.0,
        strokes: Vec::new(),
    };
    let mut start_x = 0.0;
    let mut pen_down = false;
    for (index, pair) in data.as_bytes().as_chunks::<2>().0.iter().enumerate() {
        if index == 0 {
            start_x = f64::from(coordinate(pair[0])) * FONT_SCALE;
            glyph.width = f64::from(coordinate(pair[1])) * FONT_SCALE - start_x;
        } else if pair == b" R" {
            pen_down = false;
        } else {
            let p = point(
                f64::from(coordinate(pair[0])) * FONT_SCALE - start_x,
                f64::from(coordinate(pair[1]) + FONT_OFFSET) * FONT_SCALE,
            );
            if !pen_down {
                glyph.strokes.push(Vec::new());
                pen_down = true;
            }
            if let Some(stroke) = glyph.strokes.last_mut() {
                stroke.push(p);
            }
        }
    }
    glyph
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HAlign {
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VAlign {
    Top,
    Center,
    Bottom,
}

#[derive(Clone, Copy, Debug)]
pub struct TextStyle {
    /// Glyph width in `x` and height in `y`, in mm.
    pub size: Point,
    pub pen_width: f64,
    pub degrees: f64,
    pub mirrored: bool,
    pub italic: bool,
    pub h_align: HAlign,
    pub v_align: VAlign,
    pub line_spacing: f64,
}

/// KiCad's `EDA_TEXT::GetEffectiveTextPenWidth`.
pub fn pen_width(thickness: f64, size: Point, bold: bool, bold_multiplies: bool) -> f64 {
    let pen = if thickness <= 1e-6 {
        size.x / if bold { 5.0 } else { 8.0 }
    } else if bold && bold_multiplies {
        thickness * BOLD_STROKE_MULTIPLIER
    } else {
        thickness
    };
    pen.min(size.x.abs().min(size.y.abs()) * 0.25)
}

/// Lays out `text` anchored at `anchor` and returns its strokes in board coordinates.
pub fn stroke_text(text: &str, anchor: Point, style: &TextStyle) -> Vec<Vec<Point>> {
    // KiCad's wxStringSplit drops one trailing empty line.
    let text = text.strip_suffix('\n').unwrap_or(text);
    let lines: Vec<Vec<Markup>> = text.split('\n').map(parse_markup).collect();
    let interline = style.size.y * INTERLINE_PITCH * style.line_spacing;
    let height = style.size.y * 1.17 + (lines.len() as f64 - 1.0) * interline;
    let mut offset = point(
        style.pen_width / 1.52,
        style.size.y - style.pen_width * 0.052,
    );
    match style.v_align {
        VAlign::Top => {}
        VAlign::Center => offset.y -= height / 2.0,
        VAlign::Bottom => offset.y -= height,
    }
    let mut measure = Layout {
        style,
        origin: anchor,
        strokes: None,
    };
    let mut draw = Layout {
        style,
        origin: anchor,
        strokes: Some(Vec::new()),
    };
    for (index, line) in lines.iter().enumerate() {
        let width = measure.markup(line, Point::default(), Flags::default()).x;
        let x = match style.h_align {
            HAlign::Left => offset.x,
            HAlign::Center => -width / 2.0,
            HAlign::Right => -(width + offset.x),
        };
        draw.markup(
            line,
            anchor + point(x, offset.y + index as f64 * interline),
            Flags::default(),
        );
    }
    draw.strokes.unwrap_or_default()
}

#[derive(Clone, Copy, Default)]
struct Flags {
    subscript: bool,
    superscript: bool,
}

enum Markup {
    Text(String),
    Overbar(Vec<Markup>),
    Subscript(Vec<Markup>),
    Superscript(Vec<Markup>),
}

/// Parses KiCad's `~{overbar}`, `_{subscript}` and `^{superscript}` markup.
fn parse_markup(text: &str) -> Vec<Markup> {
    /// Deeper markers stay literal text, so crafted text can't exhaust the stack.
    const MAX_DEPTH: usize = 16;

    fn parse(chars: &[char], pos: &mut usize, depth: usize) -> Vec<Markup> {
        let mut nodes = Vec::new();
        let mut run = String::new();
        while *pos < chars.len() {
            let c = chars[*pos];
            if depth < MAX_DEPTH
                && matches!(c, '~' | '_' | '^')
                && chars.get(*pos + 1) == Some(&'{')
            {
                if !run.is_empty() {
                    nodes.push(Markup::Text(std::mem::take(&mut run)));
                }
                *pos += 2;
                let children = parse(chars, pos, depth + 1);
                nodes.push(match c {
                    '~' => Markup::Overbar(children),
                    '_' => Markup::Subscript(children),
                    _ => Markup::Superscript(children),
                });
                continue;
            }
            *pos += 1;
            if c == '}' && depth > 0 {
                break;
            }
            run.push(c);
        }
        if !run.is_empty() {
            nodes.push(Markup::Text(run));
        }
        nodes
    }
    let chars: Vec<char> = text.chars().collect();
    parse(&chars, &mut 0, 0)
}

/// One walk over a line's markup. Without `strokes` it only measures.
struct Layout<'s> {
    style: &'s TextStyle,
    origin: Point,
    strokes: Option<Vec<Vec<Point>>>,
}

impl Layout<'_> {
    /// Lays out one line of markup from `position` and returns the cursor after it.
    fn markup(&mut self, nodes: &[Markup], position: Point, flags: Flags) -> Point {
        let mut cursor = position;
        for node in nodes {
            cursor = match node {
                Markup::Text(text) => self.run(text, cursor, flags),
                Markup::Subscript(children) => self.markup(
                    children,
                    cursor,
                    Flags {
                        subscript: true,
                        ..flags
                    },
                ),
                Markup::Superscript(children) => self.markup(
                    children,
                    cursor,
                    Flags {
                        superscript: true,
                        ..flags
                    },
                ),
                Markup::Overbar(children) => {
                    let end = self.markup(children, cursor, flags);
                    let trim = self.style.size.x * 0.1;
                    let lift = self.style.size.y * OVERBAR_HEIGHT;
                    self.emit(&[
                        point(cursor.x + trim, cursor.y - lift),
                        point(end.x - trim, end.y - lift),
                    ]);
                    end
                }
            };
        }
        cursor
    }

    /// KiCad's `STROKE_FONT::GetTextAsGlyphs` for one run of plain text.
    fn run(&mut self, text: &str, position: Point, flags: Flags) -> Point {
        let glyphs = glyphs();
        let size = self.style.size;
        let mut glyph_size = size;
        let mut cursor = position;
        if flags.subscript || flags.superscript {
            glyph_size = glyph_size * SUPER_SUB_SIZE;
            let offset = if flags.subscript {
                SUBSCRIPT_OFFSET
            } else {
                SUPERSCRIPT_OFFSET
            };
            cursor.y += glyph_size.y * offset;
        }
        let tilt = if self.style.italic { ITALIC_TILT } else { 0.0 };
        let space_width = glyphs[0].width;
        let mut char_count = 0;
        for c in text.chars() {
            match c {
                '\t' => {
                    char_count = (char_count / TAB_WIDTH + 1) * TAB_WIDTH - 1;
                    let mut next = position.x + size.x * (char_count as f64 + space_width);
                    while size.x > 0.0 && next <= cursor.x {
                        char_count += TAB_WIDTH;
                        next += size.x * TAB_WIDTH as f64;
                    }
                    cursor.x = next;
                }
                ' ' => cursor.x += glyph_size.x * space_width,
                _ => {
                    let index = (c as usize)
                        .checked_sub(0x20)
                        .filter(|&index| index < glyphs.len())
                        .unwrap_or(usize::from(b'?' - 0x20));
                    let glyph = &glyphs[index];
                    if self.strokes.is_some() {
                        for stroke in &glyph.strokes {
                            let points: Vec<Point> = stroke
                                .iter()
                                .map(|&p| {
                                    let mut p = point(p.x * glyph_size.x, p.y * glyph_size.y);
                                    p.x -= p.y * tilt;
                                    p + cursor
                                })
                                .collect();
                            self.emit(&points);
                        }
                    }
                    cursor.x += glyph.width * glyph_size.x;
                }
            }
            char_count += 1;
        }
        point(cursor.x, position.y)
    }

    /// Mirrors about the anchor, rotates around it, and keeps the stroke.
    fn emit(&mut self, points: &[Point]) {
        let Some(strokes) = self.strokes.as_mut() else {
            return;
        };
        let (origin, style) = (self.origin, self.style);
        strokes.push(
            points
                .iter()
                .map(|&p| {
                    let mut p = p;
                    if style.mirrored {
                        p.x = 2.0 * origin.x - p.x;
                    }
                    origin + (p - origin).rotated(style.degrees)
                })
                .collect(),
        );
    }
}

#[cfg(test)]
mod tests;
