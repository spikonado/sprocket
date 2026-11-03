use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use tokio::fs::File;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

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

#[derive(Deserialize)]
struct StoredEventBytes {
    bytes: Vec<u8>,
}

#[derive(Deserialize)]
struct StoredEventSequence {
    sequence: u64,
}

pub(crate) struct UnreturnedOutput {
    pub output: String,
    pub next_sequence: u64,
}

impl UnreturnedOutput {
    pub(crate) fn none(from_sequence: u64) -> Self {
        Self {
            output: String::new(),
            next_sequence: from_sequence,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutputPreview {
    pub output: String,
    pub complete_log_path: String,
    pub events_path: String,
}

pub(crate) struct CapturedOutput {
    log: Option<File>,
    events: Option<File>,
    log_path: String,
    events_path: String,
    sequence: u64,
    log_bytes: u64,
    limits: CommandOutputLimits,
    pending_utf8: Vec<u8>,
    full_preview: PreviewBuffer,
}

impl CapturedOutput {
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
            log_bytes: 0,
            limits,
            pending_utf8: Vec::new(),
            full_preview: PreviewBuffer::new(max_chars),
        })
    }

    pub(crate) async fn discard(&mut self) -> Result<()> {
        self.log.take();
        self.events.take();
        let directory = Path::new(&self.log_path)
            .parent()
            .expect("log has a directory");
        tokio::fs::remove_dir_all(directory)
            .await
            .context("failed to remove unstarted command logs")
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
        // Tokio file writes may return before the blocking write finishes.
        // Polls read events, so an event is written only once its bytes are logged.
        log.flush()
            .await
            .context("failed to flush command output")?;
        events
            .write_all(&encoded)
            .await
            .context("failed to spool command output event")?;
        events
            .flush()
            .await
            .context("failed to flush command output events")?;
        self.sequence += 1;
        self.log_bytes += next_bytes;
        self.decode(bytes, false);
        Ok(())
    }

    fn decode(&mut self, bytes: &[u8], final_chunk: bool) {
        decode_utf8(&mut self.pending_utf8, bytes, final_chunk, |text| {
            self.full_preview.push_text(text);
        });
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

    pub(crate) fn full_preview(&self) -> OutputPreview {
        OutputPreview {
            output: self.full_preview.clone().render(),
            ..self.preview_metadata()
        }
    }

    pub(crate) async fn read_log_preview(path: &Path, max_chars: usize) -> Result<String> {
        use tokio::io::AsyncReadExt;

        let mut file = File::open(path).await?;
        let mut preview = PreviewBuffer::new(max_chars);
        let mut buffer = [0_u8; 8_192];
        let mut pending = Vec::new();
        loop {
            let read = file.read(&mut buffer).await?;
            decode_utf8(&mut pending, &buffer[..read], read == 0, |text| {
                preview.push_text(text);
            });
            if read == 0 {
                return Ok(preview.render());
            }
        }
    }

    pub(crate) fn preview_metadata(&self) -> OutputPreview {
        OutputPreview {
            output: String::new(),
            complete_log_path: self.log_path.clone(),
            events_path: self.events_path.clone(),
        }
    }
}

/// Renders the events from `from_sequence` on. A trailing incomplete character
/// stays unrendered until a later read completes it or the stream is final.
/// A final read also consumes a virtual end-of-stream event one past the last
/// event, which renders that character as a replacement exactly once.
/// An incomplete trailing line is an append in progress and is left for later.
pub(crate) async fn read_output_events(
    events_path: &Path,
    from_sequence: u64,
    max_chars: usize,
    final_stream: bool,
) -> Result<UnreturnedOutput> {
    let mut reader = tokio::io::BufReader::new(
        File::open(events_path)
            .await
            .context("failed to open command output events")?,
    );
    let mut preview = PreviewBuffer::new(max_chars);
    let mut pending = Vec::new();
    let mut event_count = 0;
    let mut line = Vec::new();
    // A UTF-8 character spans at most 4 bytes, so only the 3 events before the
    // cursor can carry bytes into the first unread event.
    let carry_from = from_sequence.saturating_sub(3);
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line).await? == 0 || line.last() != Some(&b'\n') {
            break;
        }
        let sequence = serde_json::from_slice::<StoredEventSequence>(&line)
            .context("invalid command output event")?
            .sequence;
        event_count = sequence + 1;
        if sequence < carry_from {
            continue;
        }
        let event: StoredEventBytes =
            serde_json::from_slice(&line).context("invalid command output event")?;
        if sequence < from_sequence {
            // Bytes of a character split by the cursor carry into the first unread event.
            decode_utf8(&mut pending, &event.bytes, false, |_| {});
        } else {
            decode_utf8(&mut pending, &event.bytes, false, |text| {
                preview.push_text(text);
            });
        }
    }
    let next_sequence = if final_stream && from_sequence <= event_count {
        decode_utf8(&mut pending, &[], true, |text| preview.push_text(text));
        event_count + 1
    } else {
        event_count.max(from_sequence)
    };
    Ok(UnreturnedOutput {
        output: preview.render(),
        next_sequence,
    })
}

fn decode_utf8(
    pending: &mut Vec<u8>,
    bytes: &[u8],
    final_chunk: bool,
    mut push_text: impl FnMut(&str),
) {
    let mut combined = std::mem::take(pending);
    combined.extend_from_slice(bytes);
    let mut remaining = combined.as_slice();
    while !remaining.is_empty() {
        match std::str::from_utf8(remaining) {
            Ok(text) => {
                push_text(text);
                remaining = &[];
            }
            Err(error) => {
                let valid = error.valid_up_to();
                push_text(std::str::from_utf8(&remaining[..valid]).unwrap());
                remaining = &remaining[valid..];
                let invalid = match error.error_len() {
                    Some(len) => len,
                    None if final_chunk => remaining.len(),
                    None => break,
                };
                push_text("\u{fffd}");
                remaining = &remaining[invalid..];
            }
        }
    }
    pending.extend_from_slice(remaining);
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

#[derive(Clone)]
struct PreviewBuffer {
    max_chars: usize,
    head: Vec<char>,
    tail: VecDeque<char>,
    omitted_newlines: u64,
    last_omitted: Option<char>,
}

impl PreviewBuffer {
    fn new(max_chars: usize) -> Self {
        Self {
            max_chars,
            head: Vec::new(),
            tail: VecDeque::new(),
            omitted_newlines: 0,
            last_omitted: None,
        }
    }

    fn push_text(&mut self, text: &str) {
        for character in text.chars() {
            self.push(character);
        }
    }

    fn push(&mut self, character: char) {
        if self.head.len() < self.max_chars.div_ceil(2) {
            self.head.push(character);
        } else {
            self.tail.push_back(character);
            if self.tail.len() > self.max_chars / 2 {
                let omitted = self.tail.pop_front().unwrap();
                self.omitted_newlines += u64::from(omitted == '\n');
                self.last_omitted = Some(omitted);
            }
        }
    }

    fn render(mut self) -> String {
        if self.last_omitted.is_none() {
            return self.head.into_iter().chain(self.tail).collect();
        }
        loop {
            let lines = self.omitted_newlines + u64::from(self.last_omitted != Some('\n'));
            let noun = if lines == 1 { "line" } else { "lines" };
            let marker = format!("\n<{lines} {noun} omitted>\n");
            let retained = self.head.len() + self.tail.len();
            // A tiny internal limit must not cut the omission notice itself.
            if retained == 0 || retained + marker.len() <= self.max_chars {
                return self
                    .head
                    .into_iter()
                    .chain(marker.chars())
                    .chain(self.tail)
                    .collect();
            }
            if self.head.len() > self.tail.len() {
                let omitted = self.head.pop().unwrap();
                self.omitted_newlines += u64::from(omitted == '\n');
            } else {
                let omitted = self.tail.pop_front().unwrap();
                self.omitted_newlines += u64::from(omitted == '\n');
                self.last_omitted = Some(omitted);
            }
        }
    }
}

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
