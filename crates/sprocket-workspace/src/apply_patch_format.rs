use std::collections::HashSet;
use std::path::Path;

use anyhow::{Context, Result, anyhow, bail};

const BEGIN_PATCH: &str = "*** Begin Patch";
const END_PATCH: &str = "*** End Patch";
const ADD_FILE: &str = "*** Add File: ";
const DELETE_FILE: &str = "*** Delete File: ";
const UPDATE_FILE: &str = "*** Update File: ";
const COPY_FILE: &str = "*** Copy File: ";
const MOVE_TO: &str = "*** Move to: ";
const COPY_TO: &str = "*** Copy to: ";
const END_OF_FILE: &str = "*** End of File";
const ENVIRONMENT_ID: &str = "*** Environment ID: ";

const SHOWN_LINE_CHARS: usize = 160;
const REGION_CONTEXT_LINES: usize = 2;
const REGION_MAX_LINES: usize = 24;

pub(crate) enum PatchSection {
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
    Copy {
        path: String,
        copy_to: String,
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

pub(crate) fn parse_apply_patch(patch: &str) -> Result<Vec<PatchSection>> {
    let mut lines = strip_surrounding_markdown_fence(patch)
        .trim_start()
        .lines()
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }

    let Some(first) = lines.first().map(|line| line.trim()) else {
        bail!("patch cannot be empty");
    };
    let ends_with_end_patch = lines.last().map(|line| line.trim()) == Some(END_PATCH);
    let mut index = if first == BEGIN_PATCH {
        if !ends_with_end_patch {
            bail!("patch starts with '{BEGIN_PATCH}' but does not end with '{END_PATCH}'");
        }
        1
    } else if is_section_header(first) {
        0
    } else {
        bail!(
            "patch must start with '{BEGIN_PATCH}' or a '*** Add File:', '*** Update File:', \
             '*** Delete File:', or '*** Copy File:' header (got {})",
            quoted(first)
        );
    };
    if ends_with_end_patch {
        lines.pop();
    }

    let mut sections = Vec::new();
    while index < lines.len() {
        let header = lines[index].trim();
        if header.is_empty() || header.starts_with(ENVIRONMENT_ID) {
            index += 1;
            continue;
        }

        if let Some(path) = header.strip_prefix(ADD_FILE) {
            let path = parse_path(path, index)?;
            index += 1;
            let mut contents = Vec::new();
            while index < lines.len() && !is_file_header(lines[index]) {
                let line = lines[index].strip_prefix('+').ok_or_else(|| {
                    anyhow!(
                        "invalid add-file line {} {}: every content line must start with '+'",
                        index + 1,
                        quoted(lines[index])
                    )
                })?;
                contents.extend_from_slice(line.as_bytes());
                contents.push(b'\n');
                index += 1;
            }
            sections.push(PatchSection::Add { path, contents });
            continue;
        }

        if let Some(path) = header.strip_prefix(DELETE_FILE) {
            sections.push(PatchSection::Delete {
                path: parse_path(path, index)?,
            });
            index += 1;
            continue;
        }

        if let Some(path) = header.strip_prefix(UPDATE_FILE) {
            let path = parse_path(path, index)?;
            index += 1;
            let mut move_to = None;

            if let Some(destination) = lines
                .get(index)
                .and_then(|line| line.trim().strip_prefix(MOVE_TO))
            {
                move_to = Some(parse_path(destination, index)?);
                index += 1;
            }

            let (chunks, next_index) = parse_update_chunks(&lines, index)?;
            index = next_index;
            if chunks.is_empty() && move_to.is_none() {
                bail!("update-file section for '{path}' has no changes");
            }
            sections.push(PatchSection::Update {
                path,
                move_to,
                chunks,
            });
            continue;
        }

        if let Some(path) = header.strip_prefix(COPY_FILE) {
            let path = parse_path(path, index)?;
            index += 1;
            let copy_to = lines
                .get(index)
                .and_then(|line| line.trim().strip_prefix(COPY_TO))
                .map(|destination| parse_path(destination, index))
                .transpose()?
                .ok_or_else(|| {
                    anyhow!(
                        "copy-file section for '{path}' must be followed by '{COPY_TO}<destination>'"
                    )
                })?;
            index += 1;

            let (chunks, next_index) = parse_update_chunks(&lines, index)?;
            index = next_index;
            sections.push(PatchSection::Copy {
                path,
                copy_to,
                chunks,
            });
            continue;
        }

        bail!(
            "invalid file header at line {}: {}",
            index + 1,
            quoted(header)
        );
    }

    if sections.is_empty() {
        bail!("patch does not contain any file changes");
    }
    Ok(sections)
}

fn shortened(line: &str) -> String {
    let mut chars = line.chars();
    let mut shown = chars.by_ref().take(SHOWN_LINE_CHARS).collect::<String>();
    if chars.next().is_some() {
        shown.push('…');
    }
    shown
}

fn quoted(line: &str) -> String {
    format!("'{}'", shortened(line))
}

fn parse_path(path: &str, index: usize) -> Result<String> {
    let path = path.trim();
    if path.is_empty() {
        bail!("patch path at line {} cannot be empty", index + 1);
    }
    Ok(path.to_owned())
}

fn is_section_header(line: &str) -> bool {
    line.starts_with(ADD_FILE)
        || line.starts_with(DELETE_FILE)
        || line.starts_with(UPDATE_FILE)
        || line.starts_with(COPY_FILE)
}

fn is_file_header(line: &str) -> bool {
    // Do not trim leading whitespace: indented markers are valid context/content
    // lines (e.g. documentation that quotes apply_patch examples).
    let line = line.trim_end();
    line == END_PATCH || is_section_header(line)
}

/// `@@ -n,m +p,q @@` / `@@ -n +p @@` (optional function suffix), not Begin Patch anchors.
fn is_unified_style_hunk_header(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("@@ ") else {
        return false;
    };
    let Some((ranges, _)) = rest.split_once(" @@") else {
        return false;
    };
    let Some((old_part, new_part)) = ranges.split_once(' ') else {
        return false;
    };
    is_unified_hunk_range(old_part, '-') && is_unified_hunk_range(new_part, '+')
}

fn is_unified_hunk_range(part: &str, prefix: char) -> bool {
    let Some(range) = part.strip_prefix(prefix) else {
        return false;
    };
    let is_number = |value: &str| !value.is_empty() && value.chars().all(|c| c.is_ascii_digit());
    match range.split_once(',') {
        Some((start, len)) => is_number(start) && is_number(len),
        None => is_number(range),
    }
}

fn parse_update_chunks(lines: &[&str], mut index: usize) -> Result<(Vec<UpdateChunk>, usize)> {
    let mut chunks: Vec<UpdateChunk> = Vec::new();

    while index < lines.len() && !is_file_header(lines[index]) {
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
            if is_unified_style_hunk_header(trimmed_end) {
                bail!(
                    "invalid update line {} {}: use '@@' or '@@ anchor text'; \
                     unified hunk ranges are not supported",
                    index + 1,
                    quoted(line)
                );
            }
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
                "invalid update line {} {}: expected '@@' after '{END_OF_FILE}'",
                index + 1,
                quoted(line)
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
                    "invalid update line {} {}: lines must start with ' ', '+', or '-'",
                    index + 1,
                    quoted(line)
                );
            }
        }
        index += 1;
    }

    ensure_previous_chunk_has_lines(&chunks, index)?;
    Ok((chunks, index))
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

/// Strip a single surrounding markdown code fence (` ``` ` / ` ```diff `) when present.
fn strip_surrounding_markdown_fence(patch: &str) -> &str {
    let trimmed = patch.trim();
    let Some(after_open) = trimmed.strip_prefix("```") else {
        return patch;
    };
    let Some((language, body)) = after_open.split_once('\n') else {
        return patch;
    };
    if language
        .trim()
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    {
        return patch;
    }
    match body.rsplit_once('\n') {
        Some((content, fence)) if fence.trim() == "```" => content,
        _ => patch,
    }
}

/// A located hunk: replace `old_len` lines at `start` with `new_lines`.
struct Replacement {
    start: usize,
    old_len: usize,
    new_lines: Vec<String>,
}

impl Replacement {
    fn overlaps(&self, other: &Replacement) -> bool {
        self.start < other.start + other.old_len && other.start < self.start + self.old_len
    }
}

enum Miss {
    AnchorNotFound,
    AnchorAmbiguous(usize),
    InsideEarlierHunk,
    LinesNotFound,
    LinesAmbiguous(usize),
}

pub(crate) fn apply_update(
    path: &Path,
    contents: &[u8],
    chunks: &[UpdateChunk],
) -> Result<Vec<u8>> {
    let contents = std::str::from_utf8(contents)
        .with_context(|| format!("patch target is not valid UTF-8: {}", path.display()))?;
    let had_trailing_newline = contents.ends_with('\n');
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

    let mut replacements: Vec<Replacement> = Vec::new();
    let mut cursor = 0;
    for (index, chunk) in chunks.iter().enumerate() {
        let replacement = locate_forward(&lines, chunk, cursor)
            .filter(|found| !replacements.iter().any(|taken| found.overlaps(taken)))
            .map_or_else(|| locate_anywhere(&lines, chunk, &replacements), Ok)
            .map_err(|miss| mismatch_error(path, &lines, chunks.len(), index, chunk, miss))?;
        cursor = replacement.start + replacement.old_len;
        replacements.push(replacement);
    }

    replacements.sort_by_key(|replacement| (replacement.start, replacement.old_len));
    for replacement in replacements.into_iter().rev() {
        lines.splice(
            replacement.start..replacement.start + replacement.old_len,
            replacement.new_lines,
        );
    }

    if lines.is_empty() {
        return Ok(Vec::new());
    }

    let mut output = lines.join(line_ending).into_bytes();
    if had_trailing_newline {
        output.extend_from_slice(line_ending.as_bytes());
    }
    Ok(output)
}

/// Trailing empty strings represent the file's final newline, which is
/// stripped from the file's lines, so also try the hunk without them.
fn line_variants(chunk: &UpdateChunk) -> impl Iterator<Item = (&[String], &[String])> {
    let stripped = strip_trailing_empty(&chunk.old_lines).map(|old_lines| {
        let new_lines = strip_trailing_empty(&chunk.new_lines).unwrap_or(&chunk.new_lines);
        (old_lines, new_lines)
    });
    std::iter::once((chunk.old_lines.as_slice(), chunk.new_lines.as_slice())).chain(stripped)
}

fn insertion(chunk: &UpdateChunk, after_anchor: Option<usize>, end: usize) -> Replacement {
    let start = match after_anchor {
        Some(position) if !chunk.end_of_file => position,
        _ => end,
    };
    Replacement {
        start,
        old_len: 0,
        new_lines: chunk.new_lines.clone(),
    }
}

fn locate_forward(lines: &[String], chunk: &UpdateChunk, cursor: usize) -> Option<Replacement> {
    let after_anchor = match &chunk.context {
        Some(context) => {
            Some(find_matches(lines, std::slice::from_ref(context), cursor, false, 1)?[0] + 1)
        }
        None => None,
    };
    if chunk.old_lines.is_empty() {
        return Some(insertion(chunk, after_anchor, lines.len()));
    }
    let start = after_anchor.unwrap_or(cursor);
    line_variants(chunk).find_map(|(old_lines, new_lines)| {
        let position = find_matches(lines, old_lines, start, chunk.end_of_file, 1)?[0];
        Some(Replacement {
            start: position,
            old_len: old_lines.len(),
            new_lines: new_lines.to_vec(),
        })
    })
}

/// Fallback for out-of-order hunks: the anchor (or, without one, the lines)
/// must match exactly one place in the whole file.
fn locate_anywhere(
    lines: &[String],
    chunk: &UpdateChunk,
    taken: &[Replacement],
) -> Result<Replacement, Miss> {
    let after_anchor = match &chunk.context {
        Some(context) => {
            match find_matches(lines, std::slice::from_ref(context), 0, false, usize::MAX)
                .as_deref()
            {
                None => return Err(Miss::AnchorNotFound),
                Some([position]) => Some(position + 1),
                Some(matches) => return Err(Miss::AnchorAmbiguous(matches.len())),
            }
        }
        None => None,
    };
    if chunk.old_lines.is_empty() {
        let inserted = insertion(chunk, after_anchor, lines.len());
        if taken
            .iter()
            .any(|replacement| inserted.overlaps(replacement))
        {
            return Err(Miss::InsideEarlierHunk);
        }
        return Ok(inserted);
    }

    let start = after_anchor.unwrap_or(0);
    for (old_lines, new_lines) in line_variants(chunk) {
        let Some(matches) = find_matches(lines, old_lines, start, chunk.end_of_file, usize::MAX)
        else {
            continue;
        };
        let mut candidates = matches
            .into_iter()
            .map(|start| Replacement {
                start,
                old_len: old_lines.len(),
                new_lines: new_lines.to_vec(),
            })
            .filter(|candidate| {
                !taken
                    .iter()
                    .any(|replacement| candidate.overlaps(replacement))
            });
        let Some(first) = candidates.next() else {
            continue;
        };
        let others = candidates.count();
        if after_anchor.is_none() && others > 0 {
            return Err(Miss::LinesAmbiguous(others + 1));
        }
        return Ok(first);
    }
    Err(Miss::LinesNotFound)
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

/// Up to `limit` positions from `start` where `pattern` matches, using the
/// strictest comparison that matches anywhere so exact context always wins.
fn find_matches(
    lines: &[String],
    pattern: &[String],
    start: usize,
    end_of_file: bool,
    limit: usize,
) -> Option<Vec<usize>> {
    if pattern.len() > lines.len() || start > lines.len() - pattern.len() {
        return None;
    }

    let last = lines.len() - pattern.len();
    let range = if end_of_file {
        last..=last
    } else {
        start..=last
    };
    let comparisons: [fn(&str, &str) -> bool; 3] = [
        |line, expected| line == expected,
        |line, expected| line.trim_end() == expected.trim_end(),
        |line, expected| line.trim() == expected.trim(),
    ];
    comparisons.into_iter().find_map(|matches| {
        let positions = range
            .clone()
            .filter(|position| {
                lines[*position..*position + pattern.len()]
                    .iter()
                    .zip(pattern)
                    .all(|(line, expected)| matches(line, expected))
            })
            .take(limit)
            .collect::<Vec<_>>();
        (!positions.is_empty()).then_some(positions)
    })
}

fn mismatch_error(
    path: &Path,
    lines: &[String],
    total: usize,
    index: usize,
    chunk: &UpdateChunk,
    miss: Miss,
) -> anyhow::Error {
    let anchor = chunk
        .context
        .as_ref()
        .map(|context| format!(" (@@ {})", shortened(context)))
        .unwrap_or_default();
    let reason = match miss {
        Miss::AnchorNotFound => "the anchor line was not found".to_owned(),
        Miss::AnchorAmbiguous(count) => format!(
            "the hunk was not found after the previous hunk, and its anchor matches {count} places"
        ),
        Miss::InsideEarlierHunk => {
            "the anchor line is inside lines an earlier hunk changes".to_owned()
        }
        Miss::LinesNotFound => "the expected lines were not found".to_owned(),
        Miss::LinesAmbiguous(count) => {
            format!("the expected lines match {count} places; add context lines or an @@ anchor")
        }
    };
    let pattern = chunk
        .context
        .iter()
        .chain(&chunk.old_lines)
        .collect::<Vec<_>>();
    let region = closest_region(lines, &pattern).map_or_else(
        || "No similar lines were found in the file.".to_owned(),
        |(start, len)| format_region(lines, start, len),
    );
    anyhow!(
        "hunk {} of {total}{anchor} did not match {}: {reason}. No files were changed.\n{region}",
        index + 1,
        path.display()
    )
}

/// The window of `pattern.len()` lines sharing the most non-blank lines with
/// `pattern`, ignoring indentation.
fn closest_region(lines: &[String], pattern: &[&String]) -> Option<(usize, usize)> {
    let wanted = pattern
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<HashSet<_>>();
    if wanted.is_empty() || lines.is_empty() {
        return None;
    }
    let window = pattern.len().clamp(1, lines.len());
    let hit = |line: &String| usize::from(wanted.contains(line.trim()));
    let mut score = lines[..window].iter().map(hit).sum::<usize>();
    let (mut best_score, mut best_start) = (score, 0);
    for start in 1..=lines.len() - window {
        score = score + hit(&lines[start + window - 1]) - hit(&lines[start - 1]);
        if score > best_score {
            (best_score, best_start) = (score, start);
        }
    }
    (best_score > 0).then_some((best_start, window))
}

fn format_region(lines: &[String], start: usize, len: usize) -> String {
    let first = start.saturating_sub(REGION_CONTEXT_LINES);
    let end = (start + len + REGION_CONTEXT_LINES)
        .min(lines.len())
        .min(first + REGION_MAX_LINES);
    let width = end.to_string().len();
    let mut region = format!("Closest region of the file (lines {}-{end}):", first + 1);
    for (offset, line) in lines[first..end].iter().enumerate() {
        let number = first + offset + 1;
        region.push_str(&format!("\n{number:>width$} | {}", shortened(line)));
    }
    region
}

#[cfg(test)]
mod tests;
