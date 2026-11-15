//! A reduced board holding only what KiCad's glTF export needs to place component models.

use std::borrow::Cow;

use crate::sexpr::Expr;

const PROJECT_DIR_VARIABLE: &str = "${KIPRJMOD}";

const KEPT_BOARD_ITEMS: [&str; 9] = [
    "version",
    "generator",
    "generator_version",
    "host",
    "general",
    "paper",
    "layers",
    "setup",
    "embedded_files",
];
const KEPT_FOOTPRINT_ITEMS: [&str; 5] = ["at", "transform", "layer", "attr", "embedded_files"];

pub struct ModelsBoard {
    pub key: String,
    text: String,
}

impl ModelsBoard {
    pub(crate) fn new(text: String) -> Self {
        let mut hash = Fnv::default();
        hash.push(&text);
        Self {
            key: hash.key(),
            text,
        }
    }

    /// The board text with `${KIPRJMOD}` set to the original board's directory.
    pub fn text_in(&self, project_dir: &str) -> String {
        self.text
            .replace(PROJECT_DIR_VARIABLE, &escape(project_dir))
    }
}

pub trait Sink {
    fn push(&mut self, text: &str);
}

impl Sink for String {
    fn push(&mut self, text: &str) {
        self.push_str(text);
    }
}

/// FNV-1a keeps scene keys independent of how the writer splits the text.
pub struct Fnv(u64);

impl Default for Fnv {
    fn default() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }
}

impl Sink for Fnv {
    fn push(&mut self, text: &str) {
        for byte in text.bytes() {
            self.0 = (self.0 ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3);
        }
    }
}

impl Fnv {
    pub fn key(&self) -> String {
        format!("{:016x}", self.0)
    }
}

pub struct ModelsWriter<S> {
    out: S,
    has_models: bool,
}

impl<S: Sink> ModelsWriter<S> {
    pub fn new(mut out: S) -> Self {
        out.push("(kicad_pcb\n");
        Self {
            out,
            has_models: false,
        }
    }

    pub fn item(&mut self, item: Expr) {
        match item.head() {
            Some(head) if KEPT_BOARD_ITEMS.contains(&head) => self.write(&["  ", item.raw(), "\n"]),
            Some("footprint" | "module") => self.footprint(item),
            Some(head)
                if head.starts_with("gr_")
                    && !head.starts_with("gr_text")
                    && item.value("layer").as_deref() == Some("Edge.Cuts") =>
            {
                self.write(&["  ", item.raw(), "\n"]);
            }
            _ => {}
        }
    }

    pub fn finish(mut self) -> Option<S> {
        self.out.push(")\n");
        self.has_models.then_some(self.out)
    }

    fn write(&mut self, parts: &[&str]) {
        for part in parts {
            self.out.push(part);
        }
    }

    fn footprint(&mut self, footprint: Expr) {
        if footprint.child("model").is_none() {
            return;
        }
        let (Some(head), Some(id)) = (footprint.head(), footprint.arg(0)) else {
            return;
        };
        self.has_models = true;
        self.write(&["  (", head, " ", id.raw(), "\n"]);
        for child in footprint.args() {
            match child.head() {
                Some(name) if KEPT_FOOTPRINT_ITEMS.contains(&name) => {
                    self.write(&["    ", child.raw(), "\n"]);
                }
                // The export names each component's node by its reference.
                Some("property") if child.text_arg(0).as_deref() == Some("Reference") => {
                    if let Some(value) = child.arg(1) {
                        self.write(&["    (property \"Reference\" ", value.raw(), ")\n"]);
                    }
                }
                Some("fp_text") if child.arg(0).and_then(Expr::atom) == Some("reference") => {
                    if let Some(value) = child.arg(1) {
                        self.write(&[
                            "    (fp_text reference ",
                            value.raw(),
                            " (at 0 0) (layer \"F.SilkS\"))\n",
                        ]);
                    }
                }
                Some("model") => self.model(child),
                _ => {}
            }
        }
        self.write(&["  )\n"]);
    }

    fn model(&mut self, model: Expr) {
        let Some(path) = model.text_arg(0) else {
            return;
        };
        self.write(&["    (model \"", &escape(&export_path(&path)), "\""]);
        for setting in model.args().skip(1) {
            self.write(&[" ", setting.raw()]);
        }
        self.write(&[")\n"]);
    }
}

// glTF export needs the STEP siblings of KiCad's VRML models. Anchor relative paths
// because the reduced board is written outside the original project.
fn export_path(path: &str) -> Cow<'_, str> {
    let path = match path.rsplit_once('.') {
        Some((stem, extension)) if extension.eq_ignore_ascii_case("wrl") => {
            Cow::Owned(format!("{stem}.step"))
        }
        _ => Cow::Borrowed(path),
    };
    // Variables, absolute paths, drives, URIs such as `kicad-embed://` and `ALIAS:` paths
    // all start before the first separator.
    let anchored = path.starts_with("${")
        || path.starts_with("$(")
        || path.starts_with(['/', '\\'])
        || path
            .split(['/', '\\'])
            .next()
            .is_some_and(|first| first.contains(':'));
    if anchored {
        path
    } else {
        Cow::Owned(format!("{PROJECT_DIR_VARIABLE}/{path}"))
    }
}

/// Escapes a quoted string's contents the way KiCad's s-expression reader unescapes them.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests;
