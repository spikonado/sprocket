use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, ensure};
use serde::Serialize;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;

#[derive(Clone, Copy, Debug)]
pub struct CommandOutputLimits {
    pub max_log_bytes: u64,
    pub min_free_disk_bytes: u64,
}

impl Default for CommandOutputLimits {
    fn default() -> Self {
        Self {
            max_log_bytes: 64 * 1024 * 1024,
            min_free_disk_bytes: 256 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum OutputChannel {
    Stdout,
    Stderr,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEvent<'a> {
    sequence: u64,
    timestamp_ms: u128,
    channel: OutputChannel,
    bytes: &'a [u8],
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutputPreview {
    pub output: String,
    pub truncated: bool,
    pub head_chars: usize,
    pub output_bytes: u64,
    pub omitted_bytes: u64,
    pub omitted_lines: u64,
    pub encoding_loss_bytes: u64,
    pub total_output_bytes: u64,
    pub log_path: String,
    pub events_path: String,
}

pub(crate) struct CapturedOutput {
    log: Option<File>,
    events: Option<File>,
    log_path: String,
    events_path: String,
    sequence: u64,
    total_bytes: u64,
    log_bytes: u64,
    limits: CommandOutputLimits,
    pending_utf8: Vec<u8>,
    preview: PreviewBuffer,
}

impl CapturedOutput {
    #[cfg(test)]
    pub(crate) async fn create(log_root: &Path, max_chars: usize) -> Result<Self> {
        Self::create_with_limits(log_root, max_chars, CommandOutputLimits::default()).await
    }

    pub(crate) async fn create_with_limits(
        log_root: &Path,
        max_chars: usize,
        limits: CommandOutputLimits,
    ) -> Result<Self> {
        tokio::fs::create_dir_all(log_root)
            .await
            .context("failed to create command log directory")?;
        let log_root = tokio::fs::canonicalize(log_root).await?;
        ensure_disk_reserve(log_root.clone(), 0, limits.min_free_disk_bytes).await?;
        let mut builder = tempfile::Builder::new();
        builder.prefix("command-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(std::fs::Permissions::from_mode(0o700));
        }
        let directory = builder
            .tempdir_in(&log_root)
            .context("failed to allocate command log directory")?;
        let log_path = directory.path().join("output.log");
        let events_path = directory.path().join("events.jsonl");
        let log = File::create(&log_path).await?;
        let events = File::create(&events_path).await?;
        let log_path = log_path
            .to_str()
            .context("command log path is not UTF-8")?
            .to_owned();
        let events_path = events_path
            .to_str()
            .context("command event path is not UTF-8")?
            .to_owned();
        let _ = directory.keep();
        Ok(Self {
            log: Some(log),
            events: Some(events),
            log_path,
            events_path,
            sequence: 0,
            total_bytes: 0,
            log_bytes: 0,
            limits,
            pending_utf8: Vec::new(),
            preview: PreviewBuffer::new(max_chars),
        })
    }

    pub(crate) async fn append(&mut self, channel: OutputChannel, bytes: &[u8]) -> Result<()> {
        let event = OutputEvent {
            sequence: self.sequence,
            timestamp_ms: SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
            channel,
            bytes,
        };
        let mut encoded = serde_json::to_vec(&event)?;
        encoded.push(b'\n');
        let next_bytes = (bytes.len() + encoded.len()) as u64;
        ensure!(
            next_bytes <= self.limits.max_log_bytes.saturating_sub(self.log_bytes),
            "command output log quota of {} bytes reached; logs contain only a prefix",
            self.limits.max_log_bytes,
        );
        ensure_disk_reserve(
            Path::new(&self.log_path)
                .parent()
                .expect("log has a directory")
                .to_path_buf(),
            next_bytes,
            self.limits.min_free_disk_bytes,
        )
        .await?;
        let log = self.log.as_mut().context("command output log is closed")?;
        let events = self
            .events
            .as_mut()
            .context("command event log is closed")?;
        log.write_all(bytes)
            .await
            .context("failed to spool command output")?;
        events
            .write_all(&encoded)
            .await
            .context("failed to spool command output event")?;
        // Tokio file writes may return before the blocking write finishes.
        log.flush()
            .await
            .context("failed to flush command output")?;
        events
            .flush()
            .await
            .context("failed to flush command output events")?;
        self.sequence += 1;
        self.total_bytes += bytes.len() as u64;
        self.log_bytes += next_bytes;
        self.decode(bytes, false);
        Ok(())
    }

    fn decode(&mut self, bytes: &[u8], final_chunk: bool) {
        let mut pending = std::mem::take(&mut self.pending_utf8);
        pending.extend_from_slice(bytes);
        let mut remaining = pending.as_slice();
        while !remaining.is_empty() {
            match std::str::from_utf8(remaining) {
                Ok(text) => {
                    self.preview.push_text(text);
                    remaining = &[];
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    self.preview
                        .push_text(std::str::from_utf8(&remaining[..valid]).unwrap());
                    remaining = &remaining[valid..];
                    let invalid = match error.error_len() {
                        Some(len) => len,
                        None if final_chunk => remaining.len(),
                        None => break,
                    };
                    self.preview.push('\u{fffd}', invalid as u64);
                    self.preview.encoding_loss_bytes += invalid as u64;
                    remaining = &remaining[invalid..];
                }
            }
        }
        self.pending_utf8.extend_from_slice(remaining);
    }

    pub(crate) async fn finish(&mut self) -> Result<()> {
        self.decode(&[], true);
        let log = self.log.take().context("command output log is closed")?;
        let events = self.events.take().context("command event log is closed")?;
        let log_result = log
            .sync_all()
            .await
            .context("failed to sync command output");
        let events_result = events
            .sync_all()
            .await
            .context("failed to sync command output events");
        log_result?;
        events_result?;
        Ok(())
    }

    pub(crate) fn take_preview(&mut self) -> OutputPreview {
        let max_chars = self.preview.max_chars;
        let preview = std::mem::replace(&mut self.preview, PreviewBuffer::new(max_chars));
        OutputPreview {
            output: preview
                .head
                .iter()
                .chain(preview.tail.iter())
                .map(|unit| unit.character)
                .collect(),
            truncated: preview.omitted_bytes != 0,
            head_chars: preview.head.len(),
            output_bytes: preview.output_bytes,
            omitted_bytes: preview.omitted_bytes,
            omitted_lines: preview.omitted_lines,
            encoding_loss_bytes: preview.encoding_loss_bytes,
            total_output_bytes: self.total_bytes,
            log_path: self.log_path.clone(),
            events_path: self.events_path.clone(),
        }
    }
}

async fn ensure_disk_reserve(path: PathBuf, next_bytes: u64, reserve: u64) -> Result<()> {
    let available = tokio::task::spawn_blocking(move || fs4::available_space(path))
        .await
        .context("command log disk-space check failed")?
        .context("failed to read command log filesystem space")?;
    ensure!(
        available.saturating_sub(next_bytes) >= reserve && available >= next_bytes,
        "command output would cross the free-space reserve of {reserve} bytes; logs contain only a prefix",
    );
    Ok(())
}

struct PreviewCharacter {
    character: char,
    bytes: u64,
}

struct PreviewBuffer {
    max_chars: usize,
    head: Vec<PreviewCharacter>,
    tail: VecDeque<PreviewCharacter>,
    output_bytes: u64,
    omitted_bytes: u64,
    omitted_lines: u64,
    encoding_loss_bytes: u64,
}

impl PreviewBuffer {
    fn new(max_chars: usize) -> Self {
        Self {
            max_chars,
            head: Vec::new(),
            tail: VecDeque::new(),
            output_bytes: 0,
            omitted_bytes: 0,
            omitted_lines: 0,
            encoding_loss_bytes: 0,
        }
    }

    fn push_text(&mut self, text: &str) {
        for character in text.chars() {
            self.push(character, character.len_utf8() as u64);
        }
    }

    fn push(&mut self, character: char, bytes: u64) {
        self.output_bytes += bytes;
        let unit = PreviewCharacter { character, bytes };
        if self.head.len() < self.max_chars.div_ceil(2) {
            self.head.push(unit);
        } else {
            self.tail.push_back(unit);
            if self.tail.len() > self.max_chars / 2 {
                let omitted = self.tail.pop_front().unwrap();
                self.omitted_bytes += omitted.bytes;
                self.omitted_lines += u64::from(omitted.character == '\n');
            }
        }
    }
}

#[cfg(test)]
#[path = "command_output_tests.rs"]
mod tests;
