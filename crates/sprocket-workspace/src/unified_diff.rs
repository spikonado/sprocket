use anyhow::{Result, bail};

pub(crate) fn unidiff_path_strip(patch: &str) -> usize {
    // Header-only unified diffs often still use git's a/ and b/ path prefixes.
    let mut saw_a = false;
    let mut saw_b = false;
    for line in patch.lines() {
        let line = line.trim_start();
        if line.starts_with("--- a/") || line.starts_with("--- \"a/") {
            saw_a = true;
        } else if line.starts_with("+++ b/") || line.starts_with("+++ \"b/") {
            saw_b = true;
        }
    }
    usize::from(saw_a && saw_b)
}

/// Strip a single surrounding markdown code fence (` ``` ` / ` ```diff `) when present.
///
/// Preserves patch-body whitespace (including trailing spaces/tabs on the last hunk line).
/// Only fence-separating newlines around the closing fence are removed.
pub(crate) fn strip_surrounding_markdown_fence(patch: &str) -> &str {
    let trimmed = patch.trim();
    if !trimmed.starts_with("```") {
        // Keep the original (incl. trailing newline); trimming would invent a no-newline-at-EOF edit.
        return patch;
    }
    let after_open = &trimmed[3..];
    let Some(newline) = after_open.find('\n') else {
        return patch;
    };
    let language = after_open[..newline].trim();
    if language
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    {
        return patch;
    }
    let body = &after_open[newline + 1..];
    // Closing fence on its own line (optional indent). Avoid `trim()` on the
    // body; that would strip intentional trailing spaces/tabs from the final
    // hunk line.
    if let Some((content, fence_line)) = body.rsplit_once('\n') {
        if fence_line.trim() == "```" {
            return content.strip_suffix('\r').unwrap_or(content);
        }
    }
    if body.trim() == "```" {
        return "";
    }
    patch
}

const NO_NEWLINE_MARKER: &str = "\\ No newline at end of file";

/// Rewrite `@@` hunk lengths from the body so wrong counts cannot truncate or fail before apply.
pub(crate) fn normalize_unified_diff_hunk_counts(patch: &str) -> Result<String> {
    let had_trailing_newline = patch.ends_with('\n');
    let lines = patch
        .lines()
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();

    let mut output = Vec::with_capacity(lines.len());
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let Some((old_start, new_start, suffix)) = parse_unified_hunk_header(line) else {
            output.push(line.to_owned());
            index += 1;
            continue;
        };

        index += 1;
        let body_start = index;
        let mut old_count = 0usize;
        let mut new_count = 0usize;
        while index < lines.len() {
            if is_unified_section_boundary(&lines, index) {
                break;
            }
            let body_line = lines[index];
            // Blank lines immediately before the next file/hunk are padding, not context.
            if body_line.is_empty() && next_nonempty_is_section_boundary(&lines, index + 1) {
                break;
            }
            if is_no_newline_marker(body_line) {
                index += 1;
                continue;
            }
            match body_line.as_bytes().first() {
                None | Some(b' ') => {
                    old_count += 1;
                    new_count += 1;
                }
                Some(b'-') => old_count += 1,
                Some(b'+') => new_count += 1,
                _ => bail!(
                    "unexpected hunk body line at line {}: '{}'; \
                     expected a line starting with ' ', '+', or '-', or '{NO_NEWLINE_MARKER}'",
                    index + 1,
                    body_line
                ),
            }
            index += 1;
        }

        output.push(format_unified_hunk_header(
            old_start, old_count, new_start, new_count, suffix,
        ));
        output.extend(
            lines[body_start..index]
                .iter()
                .map(|line| (*line).to_owned()),
        );

        if index < lines.len() && !is_unified_section_boundary(&lines, index) {
            reject_orphaned_hunk_content(&lines, index)?;
        }
    }

    let mut normalized = output.join("\n");
    if had_trailing_newline {
        normalized.push('\n');
    }
    Ok(normalized)
}

/// Returns `(old_start, new_start, suffix)`; declared lengths are ignored (recounted from the body).
fn parse_unified_hunk_header(line: &str) -> Option<(usize, usize, &str)> {
    let rest = line.strip_prefix("@@ ")?;
    let (ranges, after) = rest.split_once(" @@")?;
    let (old_part, new_part) = ranges.split_once(' ')?;
    let old_part = old_part.strip_prefix('-')?;
    let new_part = new_part.strip_prefix('+')?;
    let (old_start, _) = parse_hunk_range(old_part)?;
    let (new_start, _) = parse_hunk_range(new_part)?;
    Some((old_start, new_start, after))
}

fn parse_hunk_range(range: &str) -> Option<(usize, usize)> {
    if let Some((start, len)) = range.split_once(',') {
        Some((start.parse().ok()?, len.parse().ok()?))
    } else {
        Some((range.parse().ok()?, 1))
    }
}

fn format_unified_hunk_header(
    old_start: usize,
    old_len: usize,
    new_start: usize,
    new_len: usize,
    suffix: &str,
) -> String {
    format!(
        "@@ -{} +{} @@{suffix}",
        format_hunk_range(old_start, old_len),
        format_hunk_range(new_start, new_len),
    )
}

fn format_hunk_range(start: usize, len: usize) -> String {
    if len == 1 {
        start.to_string()
    } else {
        format!("{start},{len}")
    }
}

fn is_no_newline_marker(line: &str) -> bool {
    line.starts_with(NO_NEWLINE_MARKER)
}

fn is_file_header_pair(lines: &[&str], index: usize) -> bool {
    if !lines[index].starts_with("--- ") {
        return false;
    }
    let mut next = index + 1;
    while next < lines.len() && lines[next].is_empty() {
        next += 1;
    }
    next < lines.len() && lines[next].starts_with("+++ ")
}

fn is_unified_section_boundary(lines: &[&str], index: usize) -> bool {
    let line = lines[index];
    line.starts_with("@@ ") || line.starts_with("diff --git ") || is_file_header_pair(lines, index)
}

fn next_nonempty_is_section_boundary(lines: &[&str], mut index: usize) -> bool {
    while index < lines.len() && lines[index].is_empty() {
        index += 1;
    }
    index >= lines.len() || is_unified_section_boundary(lines, index)
}

fn reject_orphaned_hunk_content(lines: &[&str], mut index: usize) -> Result<()> {
    while index < lines.len() {
        if is_unified_section_boundary(lines, index) {
            return Ok(());
        }
        if !lines[index].is_empty() {
            bail!(
                "orphaned hunk content at line {}: '{}'; \
                 fix the surrounding hunk or remove the leftover lines",
                index + 1,
                lines[index]
            );
        }
        index += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::normalize_unified_diff_hunk_counts;

    #[test]
    fn normalize_rewrites_under_and_over_declared_hunk_lengths() {
        let under = "\
--- a/file.txt
+++ b/file.txt
@@ -1,1 +1,2 @@
 keep
-old
+new
+extra
";
        let under_normalized = normalize_unified_diff_hunk_counts(under).expect("normalize");
        assert!(under_normalized.contains("@@ -1,2 +1,3 @@"));
        assert!(under_normalized.contains("+extra\n"));

        let over = "\
--- /dev/null
+++ b/file.txt
@@ -0,0 +1,5 @@
+one
+two
";
        let over_normalized = normalize_unified_diff_hunk_counts(over).expect("normalize");
        assert!(over_normalized.contains("@@ -0,0 +1,2 @@"));
    }
}
