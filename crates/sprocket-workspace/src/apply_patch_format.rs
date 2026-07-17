use std::path::Path;

use anyhow::{Context, Result, anyhow, bail};

const BEGIN_PATCH: &str = "*** Begin Patch";
const END_PATCH: &str = "*** End Patch";
const ADD_FILE: &str = "*** Add File: ";
const DELETE_FILE: &str = "*** Delete File: ";
const UPDATE_FILE: &str = "*** Update File: ";
const MOVE_TO: &str = "*** Move to: ";
const END_OF_FILE: &str = "*** End of File";
const ENVIRONMENT_ID: &str = "*** Environment ID: ";

pub(crate) enum PatchHunk {
    Add {
        path: String,
        contents: Vec<u8>,
    },
    Delete {
        path: String,
    },
    Update {
        path: String,
        move_to: Option<String>,
        chunks: Vec<UpdateChunk>,
    },
}

pub(crate) struct UpdateChunk {
    context: Option<String>,
    old_lines: Vec<String>,
    new_lines: Vec<String>,
    end_of_file: bool,
}

impl UpdateChunk {
    fn new(context: Option<String>) -> Self {
        Self {
            context,
            old_lines: Vec::new(),
            new_lines: Vec::new(),
            end_of_file: false,
        }
    }

    fn is_empty(&self) -> bool {
        self.old_lines.is_empty() && self.new_lines.is_empty()
    }
}

pub(crate) fn is_apply_patch_format(patch: &str) -> bool {
    patch.trim_start().starts_with(BEGIN_PATCH)
}

pub(crate) fn parse_apply_patch(patch: &str) -> Result<Vec<PatchHunk>> {
    let lines = patch
        .trim()
        .lines()
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();

    if lines.first().map(|line| line.trim()) != Some(BEGIN_PATCH) {
        bail!("apply_patch input must start with '{BEGIN_PATCH}'");
    }
    if lines.last().map(|line| line.trim()) != Some(END_PATCH) {
        bail!("apply_patch input must end with '{END_PATCH}'");
    }

    let mut hunks = Vec::new();
    let mut index = 1;
    while index < lines.len() - 1 {
        let header = lines[index].trim();
        if header.is_empty() || header.starts_with(ENVIRONMENT_ID) {
            index += 1;
            continue;
        }

        if let Some(path) = header.strip_prefix(ADD_FILE) {
            let path = parse_path(path, index)?;
            index += 1;
            let mut contents = Vec::new();
            while index < lines.len() - 1 && !is_file_header(lines[index]) {
                let line = lines[index].strip_prefix('+').ok_or_else(|| {
                    anyhow!(
                        "invalid add-file line {}: every content line must start with '+'",
                        index + 1
                    )
                })?;
                contents.extend_from_slice(line.as_bytes());
                contents.push(b'\n');
                index += 1;
            }
            if contents.is_empty() {
                bail!("add-file hunk for '{path}' has no content");
            }
            hunks.push(PatchHunk::Add { path, contents });
            continue;
        }

        if let Some(path) = header.strip_prefix(DELETE_FILE) {
            hunks.push(PatchHunk::Delete {
                path: parse_path(path, index)?,
            });
            index += 1;
            continue;
        }

        if let Some(path) = header.strip_prefix(UPDATE_FILE) {
            let path = parse_path(path, index)?;
            index += 1;
            let mut move_to = None;
            let mut chunks: Vec<UpdateChunk> = Vec::new();

            if index < lines.len() - 1 {
                let line = lines[index].trim();
                if let Some(destination) = line.strip_prefix(MOVE_TO) {
                    move_to = Some(parse_path(destination, index)?);
                    index += 1;
                }
            }

            while index < lines.len() - 1 && !is_file_header(lines[index]) {
                let line = lines[index];
                let trimmed_end = line.trim_end();
                let previous_ended = chunks.last().is_some_and(|chunk| chunk.end_of_file);

                if previous_ended && line.is_empty() {
                    index += 1;
                    continue;
                }

                if trimmed_end == "@@" {
                    ensure_previous_chunk_has_lines(&chunks, index)?;
                    chunks.push(UpdateChunk::new(None));
                } else if let Some(context) = trimmed_end.strip_prefix("@@ ") {
                    ensure_previous_chunk_has_lines(&chunks, index)?;
                    chunks.push(UpdateChunk::new(Some(context.to_owned())));
                } else if trimmed_end == END_OF_FILE {
                    match chunks.last_mut() {
                        Some(chunk) if !chunk.is_empty() => chunk.end_of_file = true,
                        _ => bail!(
                            "invalid update line {}: '{END_OF_FILE}' must follow a change",
                            index + 1
                        ),
                    }
                } else if previous_ended {
                    bail!(
                        "invalid update line {}: expected '@@' after '{END_OF_FILE}'",
                        index + 1
                    );
                } else {
                    if chunks.is_empty() {
                        chunks.push(UpdateChunk::new(None));
                    }
                    let chunk = chunks.last_mut().expect("chunk exists");
                    if let Some(content) = line.strip_prefix(' ') {
                        chunk.old_lines.push(content.to_owned());
                        chunk.new_lines.push(content.to_owned());
                    } else if let Some(content) = line.strip_prefix('+') {
                        chunk.new_lines.push(content.to_owned());
                    } else if let Some(content) = line.strip_prefix('-') {
                        chunk.old_lines.push(content.to_owned());
                    } else if line.is_empty() {
                        chunk.old_lines.push(String::new());
                        chunk.new_lines.push(String::new());
                    } else {
                        bail!(
                            "invalid update line {}: lines must start with ' ', '+', or '-'",
                            index + 1
                        );
                    }
                }
                index += 1;
            }

            ensure_previous_chunk_has_lines(&chunks, index)?;
            if chunks.is_empty() {
                bail!("update-file hunk for '{path}' has no changes");
            }
            hunks.push(PatchHunk::Update {
                path,
                move_to,
                chunks,
            });
            continue;
        }

        bail!(
            "invalid apply_patch hunk header at line {}: '{header}'",
            index + 1
        );
    }

    if hunks.is_empty() {
        bail!("patch does not contain any file changes");
    }
    Ok(hunks)
}

fn parse_path(path: &str, index: usize) -> Result<String> {
    let path = path.trim();
    if path.is_empty() {
        bail!("patch path at line {} cannot be empty", index + 1);
    }
    Ok(path.to_owned())
}

fn is_file_header(line: &str) -> bool {
    // Do not trim leading whitespace: indented markers are valid context/content
    // lines (e.g. documentation that quotes apply_patch examples).
    let line = line.trim_end();
    line == END_PATCH
        || line.starts_with(ADD_FILE)
        || line.starts_with(DELETE_FILE)
        || line.starts_with(UPDATE_FILE)
}

fn ensure_previous_chunk_has_lines(chunks: &[UpdateChunk], index: usize) -> Result<()> {
    if chunks.last().is_some_and(UpdateChunk::is_empty) {
        bail!(
            "invalid update hunk at line {}: change contains no lines",
            index + 1
        );
    }
    Ok(())
}

pub(crate) fn apply_update(
    path: &Path,
    contents: &[u8],
    chunks: &[UpdateChunk],
) -> Result<Vec<u8>> {
    let contents = std::str::from_utf8(contents)
        .with_context(|| format!("patch target is not valid UTF-8: {}", path.display()))?;
    let line_ending = if uses_crlf(contents) { "\r\n" } else { "\n" };
    let normalized = if line_ending == "\r\n" {
        contents.replace("\r\n", "\n")
    } else {
        contents.to_owned()
    };
    let mut lines = normalized
        .split('\n')
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }

    let mut replacements = Vec::new();
    let mut cursor = 0;
    for chunk in chunks {
        let context_position = match &chunk.context {
            Some(context) => Some(
                find_sequence(&lines, std::slice::from_ref(context), cursor, false).ok_or_else(
                    || anyhow!("failed to find context '{context}' in {}", path.display()),
                )?,
            ),
            None => None,
        };
        if let Some(position) = context_position {
            cursor = position + 1;
        }

        let (position, old_len, new_lines) = if chunk.old_lines.is_empty() {
            let position = if chunk.end_of_file || context_position.is_none() {
                lines.len()
            } else {
                cursor
            };
            (position, 0, chunk.new_lines.clone())
        } else {
            locate_chunk_lines(&lines, chunk, cursor).ok_or_else(|| {
                anyhow!(
                    "failed to find expected lines in {}:\n{}",
                    path.display(),
                    chunk.old_lines.join("\n")
                )
            })?
        };

        replacements.push((position, old_len, new_lines));
        cursor = position + old_len;
    }

    for (position, old_len, new_lines) in replacements.into_iter().rev() {
        lines.splice(position..position + old_len, new_lines);
    }

    if lines.is_empty() {
        return Ok(Vec::new());
    }

    let mut output = lines.join(line_ending).into_bytes();
    output.extend_from_slice(line_ending.as_bytes());
    Ok(output)
}

fn locate_chunk_lines(
    lines: &[String],
    chunk: &UpdateChunk,
    cursor: usize,
) -> Option<(usize, usize, Vec<String>)> {
    if let Some(position) = find_sequence(lines, &chunk.old_lines, cursor, chunk.end_of_file) {
        return Some((position, chunk.old_lines.len(), chunk.new_lines.clone()));
    }

    // Trailing empty strings represent the file's final newline, which
    // is stripped from `lines` above.
    let old_lines = strip_trailing_empty(&chunk.old_lines)?;
    let new_lines = strip_trailing_empty(&chunk.new_lines).unwrap_or(&chunk.new_lines);
    let position = find_sequence(lines, old_lines, cursor, chunk.end_of_file)?;
    Some((position, old_lines.len(), new_lines.to_vec()))
}

fn strip_trailing_empty(lines: &[String]) -> Option<&[String]> {
    match lines.split_last() {
        Some((last, rest)) if last.is_empty() => Some(rest),
        _ => None,
    }
}

fn uses_crlf(contents: &str) -> bool {
    let bytes = contents.as_bytes();
    let mut saw_newline = false;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        saw_newline = true;
        if index == 0 || bytes[index - 1] != b'\r' {
            return false;
        }
    }
    saw_newline
}

fn find_sequence(
    lines: &[String],
    pattern: &[String],
    start: usize,
    end_of_file: bool,
) -> Option<usize> {
    if pattern.is_empty() {
        return Some(start.min(lines.len()));
    }
    if pattern.len() > lines.len() || start > lines.len() - pattern.len() {
        return None;
    }

    let last = lines.len() - pattern.len();
    let range = if end_of_file {
        last..=last
    } else {
        start..=last
    };
    // Try progressively fuzzier matches so exact context always wins.
    let comparisons: [fn(&str, &str) -> bool; 3] = [
        |line, expected| line == expected,
        |line, expected| line.trim_end() == expected.trim_end(),
        |line, expected| line.trim() == expected.trim(),
    ];
    comparisons.into_iter().find_map(|matches| {
        range.clone().find(|position| {
            lines[*position..*position + pattern.len()]
                .iter()
                .zip(pattern)
                .all(|(line, expected)| matches(line, expected))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_blank_lines_after_end_of_file() {
        let hunks = parse_apply_patch(
            "*** Begin Patch\n\
             *** Update File: file.txt\n\
             @@\n\
             +quux\n\
             *** End of File\n\
             \n\
             *** End Patch",
        )
        .expect("parse");

        match &hunks[..] {
            [PatchHunk::Update { chunks, .. }] => {
                assert_eq!(chunks.len(), 1);
                assert_eq!(chunks[0].old_lines, Vec::<String>::new());
                assert_eq!(chunks[0].new_lines, vec!["quux".to_owned()]);
                assert!(chunks[0].end_of_file);
            }
            _ => panic!("expected a single update hunk"),
        }
    }

    #[test]
    fn applies_update_with_trailing_newline_sentinel() {
        let updated = apply_update(
            Path::new("file.txt"),
            b"alpha\nbeta\n",
            &[UpdateChunk {
                context: None,
                old_lines: vec!["beta".to_owned(), String::new()],
                new_lines: vec!["beta".to_owned(), "gamma".to_owned(), String::new()],
                end_of_file: true,
            }],
        )
        .expect("apply");

        assert_eq!(updated, b"alpha\nbeta\ngamma\n");
    }

    #[test]
    fn deleting_all_content_yields_empty_file() {
        let updated = apply_update(
            Path::new("file.txt"),
            b"only\n",
            &[UpdateChunk {
                context: None,
                old_lines: vec!["only".to_owned()],
                new_lines: Vec::new(),
                end_of_file: true,
            }],
        )
        .expect("apply");

        assert_eq!(updated, b"");
    }

    #[test]
    fn indented_update_marker_is_not_a_file_header() {
        // Keep the leading space on the context line; do not use `\` line
        // continuations here because Rust would eat that indentation.
        let hunks = parse_apply_patch(
            "*** Begin Patch\n*** Update File: file.txt\n@@\n-old\n *** Update File: example\n+new\n*** End Patch",
        )
        .expect("parse");

        match &hunks[..] {
            [PatchHunk::Update { chunks, .. }] => {
                assert_eq!(chunks.len(), 1);
                assert_eq!(
                    chunks[0].old_lines,
                    vec!["old".to_owned(), "*** Update File: example".to_owned()]
                );
                assert_eq!(
                    chunks[0].new_lines,
                    vec!["*** Update File: example".to_owned(), "new".to_owned()]
                );
            }
            _ => panic!("expected a single update hunk"),
        }
    }
}
