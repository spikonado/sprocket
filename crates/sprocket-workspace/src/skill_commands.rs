//! Runs `` !`command` `` placeholders in a skill body when the skill loads.
//! The README's skills section documents the matching rules.

use std::ffi::OsString;
use std::ops::Range;
use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use anyhow::Result;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::time::Instant;

use crate::command_shell::{default_command_shell, resolve_command_shell};
use crate::commands::{
    WorkspaceCancellation, WorkspaceOperationCancelled, build_shell_command,
    stop_processes_after_shell_exit, terminate_child,
};

const MAX_ERROR_DETAIL_CHARS: usize = 200;

#[derive(Clone, Copy)]
pub(crate) struct SkillCommandLimits {
    pub command_timeout: Duration,
    /// Bounds a whole skill load; later placeholders are skipped once spent.
    pub total_timeout: Duration,
    pub max_output_bytes: usize,
}

impl SkillCommandLimits {
    pub(crate) const DEFAULT: Self = Self {
        command_timeout: Duration::from_secs(30),
        total_timeout: Duration::from_secs(60),
        max_output_bytes: 20_000,
    };
}

pub(crate) struct Placeholder<'a> {
    pub range: Range<usize>,
    pub command: &'a str,
}

/// Commands run one at a time in document order. Output is inserted as-is
/// and never scanned for further placeholders.
pub(crate) async fn render_skill_commands(
    body: &str,
    cwd: &Path,
    environment: &[(OsString, OsString)],
    cancellation: &WorkspaceCancellation,
    limits: SkillCommandLimits,
) -> Result<String> {
    let placeholders = find_placeholders(body);
    if placeholders.is_empty() {
        return Ok(body.to_string());
    }

    let deadline = Instant::now() + limits.total_timeout;
    let default_shell = default_command_shell();
    let shell = resolve_command_shell(&default_shell, cwd).map_err(|error| {
        format!(
            "could not start shell \"{default_shell}\": {}",
            truncate_chars(&error.root_cause().to_string())
        )
    });
    let mut rendered = String::with_capacity(body.len());
    let mut copied = 0;
    for placeholder in placeholders {
        cancellation.ensure_active()?;
        rendered.push_str(&body[copied..placeholder.range.start]);
        let timeout = limits
            .command_timeout
            .min(deadline.saturating_duration_since(Instant::now()));
        let replacement = match &shell {
            Err(error) => format!("[skill command failed: {error}]"),
            Ok(_) if timeout.is_zero() => format!(
                "[skill command skipped: skill commands used their {} total time limit]",
                seconds(limits.total_timeout)
            ),
            Ok(shell) => match run_skill_command(
                placeholder.command,
                shell,
                cwd,
                environment,
                cancellation,
                timeout,
                limits.max_output_bytes,
            )
            .await?
            {
                Ok(output) => output,
                Err(error) => format!("[skill command failed: {error}]"),
            },
        };
        rendered.push_str(&replacement);
        copied = placeholder.range.end;
    }
    rendered.push_str(&body[copied..]);
    Ok(rendered)
}

pub(crate) fn find_placeholders(body: &str) -> Vec<Placeholder<'_>> {
    let mut placeholders = Vec::new();
    let mut open_fence: Option<(u8, usize)> = None;
    // Code spans can cross lines but not blank lines or fences, so each
    // paragraph is scanned as one unit.
    let mut paragraph_start: Option<usize> = None;
    let mut line_start = 0;
    for line in body.split_inclusive('\n') {
        let content = line.trim_end_matches(is_line_ending);
        match open_fence {
            Some((marker, length)) => {
                if closes_fence(content, marker, length) {
                    open_fence = None;
                }
            }
            None => {
                let fence = opening_fence(content);
                if fence.is_some() || content.trim().is_empty() {
                    if let Some(start) = paragraph_start.take() {
                        find_inline_placeholders(
                            &body[start..line_start],
                            start,
                            &mut placeholders,
                        );
                    }
                    open_fence = fence;
                } else {
                    paragraph_start.get_or_insert(line_start);
                }
            }
        }
        line_start += line.len();
    }
    if let Some(start) = paragraph_start {
        find_inline_placeholders(&body[start..], start, &mut placeholders);
    }
    placeholders
}

fn fence_run(line: &str) -> Option<(u8, usize, &str)> {
    let rest = line.trim_start();
    let marker = *rest.as_bytes().first()?;
    if marker != b'`' && marker != b'~' {
        return None;
    }
    let length = rest.bytes().take_while(|&byte| byte == marker).count();
    (length >= 3).then(|| (marker, length, &rest[length..]))
}

fn opening_fence(line: &str) -> Option<(u8, usize)> {
    let (marker, length, info) = fence_run(line)?;
    // CommonMark: a backtick fence's info string cannot contain backticks.
    if marker == b'`' && info.contains('`') {
        return None;
    }
    Some((marker, length))
}

fn closes_fence(line: &str, marker: u8, length: usize) -> bool {
    matches!(
        fence_run(line),
        Some((found, found_length, rest))
            if found == marker && found_length >= length && rest.trim().is_empty()
    )
}

fn find_inline_placeholders<'a>(
    text: &'a str,
    offset: usize,
    placeholders: &mut Vec<Placeholder<'a>>,
) {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'`' {
            index += 1;
            continue;
        }
        let run = backtick_run(bytes, index);
        let Some(close) = closing_backtick_run(bytes, index + run, run) else {
            // An unmatched backtick run is literal text.
            index += run;
            continue;
        };
        let span = &text[index + 1..close];
        if run == 1 && !span.contains(is_line_ending) && placeholder_bang_before(text, index) {
            let command = span.trim();
            if !command.is_empty() {
                placeholders.push(Placeholder {
                    range: offset + index - 1..offset + close + 1,
                    command,
                });
            }
        }
        index = close + run;
    }
}

fn placeholder_bang_before(line: &str, backtick: usize) -> bool {
    backtick > 0
        && line.as_bytes()[backtick - 1] == b'!'
        && line[..backtick - 1]
            .chars()
            .next_back()
            .is_none_or(char::is_whitespace)
}

fn backtick_run(bytes: &[u8], start: usize) -> usize {
    bytes[start..]
        .iter()
        .take_while(|&&byte| byte == b'`')
        .count()
}

fn closing_backtick_run(bytes: &[u8], from: usize, run: usize) -> Option<usize> {
    let mut index = from;
    while index < bytes.len() {
        if bytes[index] == b'`' {
            let length = backtick_run(bytes, index);
            if length == run {
                return Some(index);
            }
            index += length;
        } else {
            index += 1;
        }
    }
    None
}

/// The outer error is cancellation; the inner error is the placeholder's
/// replacement text.
async fn run_skill_command(
    command: &str,
    shell: &str,
    cwd: &Path,
    environment: &[(OsString, OsString)],
    cancellation: &WorkspaceCancellation,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<Result<String, String>> {
    let mut process = build_shell_command(command, shell);
    process
        .current_dir(cwd)
        .envs(environment.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    process.process_group(0);
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Ok(Err(format!(
                "could not start shell \"{shell}\" in {}: {error}",
                cwd.display()
            )));
        }
    };
    let process_id = child.id();
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let mut output = CappedOutput::new(max_output_bytes);

    let finished = {
        let run = async {
            tokio::join!(
                async {
                    let status = child.wait().await;
                    // Background children would otherwise hold the pipes open.
                    let _ = stop_processes_after_shell_exit(process_id);
                    status
                },
                capture_merged(stdout, stderr, &mut output),
            )
        };
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => None,
            result = tokio::time::timeout(timeout, run) => Some(result),
        }
    };
    let (status, captured) = match finished {
        None => {
            let _ = terminate_child(&mut child, process_id).await;
            return Err(WorkspaceOperationCancelled.into());
        }
        Some(Err(_)) => {
            let _ = terminate_child(&mut child, process_id).await;
            return Ok(Err(format!("timed out after {}", seconds(timeout))));
        }
        Some(Ok(result)) => result,
    };
    let status = match status {
        Ok(status) => status,
        Err(error) => return Ok(Err(format!("could not wait for the command: {error}"))),
    };
    if let Err(error) = captured {
        return Ok(Err(format!("could not read the command output: {error}")));
    }
    if status.success() {
        Ok(Ok(output.text()))
    } else {
        Ok(Err(exit_failure(status, &output)))
    }
}

async fn capture_merged(
    mut stdout: impl AsyncRead + Unpin,
    mut stderr: impl AsyncRead + Unpin,
    output: &mut CappedOutput,
) -> std::io::Result<()> {
    let mut stdout_buffer = [0_u8; 8_192];
    let mut stderr_buffer = [0_u8; 8_192];
    let mut stdout_open = true;
    let mut stderr_open = true;
    while stdout_open || stderr_open {
        tokio::select! {
            read = stdout.read(&mut stdout_buffer), if stdout_open => {
                let read = read?;
                stdout_open = read != 0;
                output.push(&stdout_buffer[..read]);
            },
            read = stderr.read(&mut stderr_buffer), if stderr_open => {
                let read = read?;
                stderr_open = read != 0;
                output.push(&stderr_buffer[..read]);
            },
        }
    }
    Ok(())
}

struct CappedOutput {
    kept: Vec<u8>,
    total_bytes: usize,
    max_bytes: usize,
}

impl CappedOutput {
    fn new(max_bytes: usize) -> Self {
        Self {
            kept: Vec::new(),
            total_bytes: 0,
            max_bytes,
        }
    }

    /// Keeps reading past the cap so a chatty command doesn't block on a full pipe.
    fn push(&mut self, chunk: &[u8]) {
        let room = self.max_bytes.saturating_sub(self.kept.len());
        self.kept.extend_from_slice(&chunk[..chunk.len().min(room)]);
        self.total_bytes += chunk.len();
    }

    fn kept_text(&self) -> String {
        let valid = match std::str::from_utf8(&self.kept) {
            Err(error) if error.error_len().is_none() => &self.kept[..error.valid_up_to()],
            _ => &self.kept[..],
        };
        String::from_utf8_lossy(valid)
            .trim_end_matches(is_line_ending)
            .to_string()
    }

    fn text(&self) -> String {
        let text = self.kept_text();
        if self.total_bytes > self.kept.len() {
            format!(
                "{text}\n[output truncated: showing the first {} of {} bytes]",
                self.kept.len(),
                self.total_bytes
            )
        } else {
            text
        }
    }
}

fn exit_failure(status: ExitStatus, output: &CappedOutput) -> String {
    let reason = match status.code() {
        Some(code) => format!("exit code {code}"),
        None => "terminated by a signal".to_string(),
    };
    let text = output.kept_text();
    match text.lines().map(str::trim).rfind(|line| !line.is_empty()) {
        Some(line) => format!("{reason}: {}", truncate_chars(line)),
        None => reason,
    }
}

fn truncate_chars(text: &str) -> String {
    match text.char_indices().nth(MAX_ERROR_DETAIL_CHARS) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_string(),
    }
}

fn seconds(duration: Duration) -> String {
    format!("{:.1}s", duration.as_secs_f64())
}

fn is_line_ending(character: char) -> bool {
    character == '\n' || character == '\r'
}

#[cfg(test)]
mod tests;
