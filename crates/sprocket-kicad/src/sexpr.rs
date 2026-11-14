use std::borrow::Cow;

use anyhow::{Result, bail};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    List,
    Atom,
    Str,
    EscapedStr,
}

/// One node of a flattened subtree. `next` is the index of the following sibling, so lists
/// iterate their children without per-list allocations.
#[derive(Clone, Copy)]
struct Node {
    kind: Kind,
    start: u32,
    end: u32,
    next: u32,
}

/// One parsed top-level item. The buffers are reused for every item, so a large file never
/// becomes one tree.
pub struct Tree<'a> {
    src: &'a str,
    nodes: Vec<Node>,
    stack: Vec<u32>,
}

#[derive(Clone, Copy)]
pub struct Expr<'t, 'a> {
    tree: &'t Tree<'a>,
    index: u32,
}

/// Calls `visit` with each child list of the root list, which must start with `root`.
/// Atoms directly under the root are skipped.
pub fn for_each_item<'a>(
    src: &'a str,
    root: &str,
    mut visit: impl FnMut(Expr<'_, 'a>) -> Result<()>,
) -> Result<()> {
    if src.len() >= u32::MAX as usize {
        bail!("file is too large");
    }
    let bytes = src.as_bytes();
    let mut pos = skip_space(bytes, 0);
    if bytes.get(pos) != Some(&b'(') {
        bail!("not an s-expression file");
    }
    pos = skip_space(bytes, pos + 1);
    let head_end = atom_end(bytes, pos);
    if &src[pos..head_end] != root {
        bail!("expected a ({root} …) file");
    }
    pos = head_end;
    let mut tree = Tree {
        src,
        nodes: Vec::new(),
        stack: Vec::new(),
    };
    loop {
        pos = skip_space(bytes, pos);
        match bytes.get(pos) {
            None => bail!("the file ends before ({root} …) closes"),
            Some(b')') => return Ok(()),
            Some(b'(') => {
                pos = tree.parse(pos)?;
                visit(Expr {
                    tree: &tree,
                    index: 0,
                })?;
            }
            Some(b'"') => pos = string_end(bytes, pos)?.0 + 1,
            Some(_) => pos = atom_end(bytes, pos),
        }
    }
}

impl<'a> Tree<'a> {
    /// Parses the list starting at `start` and returns the offset after it.
    fn parse(&mut self, start: usize) -> Result<usize> {
        let bytes = self.src.as_bytes();
        self.nodes.clear();
        self.stack.clear();
        let mut pos = start;
        loop {
            pos = skip_space(bytes, pos);
            let Some(&byte) = bytes.get(pos) else {
                bail!("the file ends inside a list that starts at byte {start}");
            };
            match byte {
                b'(' => {
                    self.stack.push(self.nodes.len() as u32);
                    self.push(Kind::List, pos, pos);
                    pos += 1;
                }
                b')' => {
                    let Some(open) = self.stack.pop() else {
                        unreachable!("the root list closes the loop");
                    };
                    let next = self.nodes.len() as u32;
                    let node = &mut self.nodes[open as usize];
                    node.end = (pos + 1) as u32;
                    node.next = next;
                    pos += 1;
                    if self.stack.is_empty() {
                        return Ok(pos);
                    }
                }
                b'"' => {
                    let (end, escaped) = string_end(bytes, pos)?;
                    let kind = if escaped { Kind::EscapedStr } else { Kind::Str };
                    self.push(kind, pos + 1, end);
                    pos = end + 1;
                }
                _ => {
                    let end = atom_end(bytes, pos);
                    self.push(Kind::Atom, pos, end);
                    pos = end;
                }
            }
        }
    }

    fn push(&mut self, kind: Kind, start: usize, end: usize) {
        let index = self.nodes.len() as u32;
        self.nodes.push(Node {
            kind,
            start: start as u32,
            end: end as u32,
            next: index + 1,
        });
    }
}

fn skip_space(bytes: &[u8], mut pos: usize) -> usize {
    while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }
    pos
}

fn atom_end(bytes: &[u8], mut pos: usize) -> usize {
    while pos < bytes.len()
        && !matches!(bytes[pos], b'(' | b')' | b'"')
        && !bytes[pos].is_ascii_whitespace()
    {
        pos += 1;
    }
    pos
}

/// Returns the offset of the closing quote and whether the string has escapes.
fn string_end(bytes: &[u8], open: usize) -> Result<(usize, bool)> {
    let mut pos = open + 1;
    let mut escaped = false;
    while pos < bytes.len() {
        match bytes[pos] {
            b'"' => return Ok((pos, escaped)),
            b'\\' => {
                escaped = true;
                pos += 2;
            }
            _ => pos += 1,
        }
    }
    bail!("the file ends inside a string that starts at byte {open}")
}

fn unescape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

impl<'t, 'a> Expr<'t, 'a> {
    fn node(self) -> Node {
        self.tree.nodes[self.index as usize]
    }

    /// The source text of a list including its parentheses, or a string without its quotes.
    fn source(self) -> &'a str {
        let node = self.node();
        &self.tree.src[node.start as usize..node.end as usize]
    }

    /// The value of an atom or string; `None` for lists.
    pub fn text(self) -> Option<Cow<'a, str>> {
        match self.node().kind {
            Kind::List => None,
            Kind::Atom | Kind::Str => Some(Cow::Borrowed(self.source())),
            Kind::EscapedStr => Some(Cow::Owned(unescape(self.source()))),
        }
    }

    /// The value of an unquoted atom; `None` for strings and lists.
    pub fn atom(self) -> Option<&'a str> {
        (self.node().kind == Kind::Atom).then(|| self.source())
    }

    pub fn number(self) -> Option<f64> {
        self.atom()?.parse().ok()
    }

    pub fn children(self) -> Children<'t, 'a> {
        let node = self.node();
        let (next, end) = if node.kind == Kind::List {
            (self.index + 1, node.next)
        } else {
            (0, 0)
        };
        Children {
            tree: self.tree,
            next,
            end,
        }
    }

    /// The first child when it is an atom, such as `segment` in `(segment …)`.
    pub fn head(self) -> Option<&'a str> {
        self.children().next()?.atom()
    }

    /// Children after the head.
    pub fn args(self) -> impl Iterator<Item = Expr<'t, 'a>> {
        self.children().skip(1)
    }

    pub fn arg(self, index: usize) -> Option<Expr<'t, 'a>> {
        self.args().nth(index)
    }

    pub fn text_arg(self, index: usize) -> Option<Cow<'a, str>> {
        self.arg(index)?.text()
    }

    pub fn number_arg(self, index: usize) -> Option<f64> {
        self.arg(index)?.number()
    }

    /// The first child list named `name`.
    pub fn child(self, name: &str) -> Option<Expr<'t, 'a>> {
        self.children_named(name).next()
    }

    pub fn children_named(self, name: &str) -> impl Iterator<Item = Expr<'t, 'a>> {
        self.children()
            .filter(move |child| child.head() == Some(name))
    }

    /// The first argument of the child list `name`, as in `(layer "F.Cu")`.
    pub fn value(self, name: &str) -> Option<Cow<'a, str>> {
        self.child(name)?.text_arg(0)
    }

    pub fn number_value(self, name: &str) -> Option<f64> {
        self.child(name)?.number_arg(0)
    }

    /// Whether a bare atom `name` appears among the arguments, as in `(fp_text … hide)`.
    pub fn has_flag(self, name: &str) -> bool {
        self.args().any(|arg| arg.atom() == Some(name))
    }

    /// Reads `(name yes)`, `(name)`, or a bare `name` flag.
    pub fn flag(self, name: &str) -> bool {
        if let Some(child) = self.child(name) {
            return child
                .arg(0)
                .and_then(Expr::atom)
                .is_none_or(|value| matches!(value, "yes" | "true"));
        }
        self.has_flag(name)
    }
}

pub struct Children<'t, 'a> {
    tree: &'t Tree<'a>,
    next: u32,
    end: u32,
}

impl<'t, 'a> Iterator for Children<'t, 'a> {
    type Item = Expr<'t, 'a>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.next >= self.end {
            return None;
        }
        let index = self.next;
        self.next = self.tree.nodes[index as usize].next;
        Some(Expr {
            tree: self.tree,
            index,
        })
    }
}

#[cfg(test)]
mod tests;
