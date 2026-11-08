//! Drives `claude setup-token` in a pty, since it prints nothing without a terminal.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{Context, bail};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tempfile::TempDir;
use tokio::sync::mpsc;
use tokio::time::Instant;

const URL_TIMEOUT: Duration = Duration::from_secs(30);
const TOKEN_TIMEOUT: Duration = Duration::from_secs(60);
/// Claude Code reads a code and Enter written together as one paste, so Enter waits.
const ENTER_DELAY: Duration = Duration::from_millis(250);
const EXIT_TEXT_TAIL: usize = 400;
const TOKEN_PREFIX: &str = "sk-ant-oat01-";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    pub login_id: String,
    pub url: String,
}

/// Holds one sign-in at a time. Starting another replaces it.
#[derive(Default)]
pub(super) struct Logins {
    current: Mutex<Option<(String, Session)>>,
}

impl Logins {
    fn current(&self) -> MutexGuard<'_, Option<(String, Session)>> {
        self.current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(super) async fn start(&self, executable: &Path) -> anyhow::Result<LoginStart> {
        self.current().take();
        let mut session = Session::spawn(executable)?;
        let url = session.wait_for(0, URL_TIMEOUT, authorize_url).await?;
        let login_id = uuid::Uuid::new_v4().to_string();
        *self.current() = Some((login_id.clone(), session));
        Ok(LoginStart { login_id, url })
    }

    pub(super) async fn finish(&self, login_id: &str, code: &str) -> anyhow::Result<String> {
        let mut session = self
            .take(login_id)
            .context("This sign-in expired. Start it again.")?;
        session.submit(code.trim()).await
    }

    pub(super) fn cancel(&self, login_id: &str) {
        self.take(login_id);
    }

    fn take(&self, login_id: &str) -> Option<Session> {
        let mut current = self.current();
        match current.take() {
            Some((id, session)) if id == login_id => Some(session),
            other => {
                *current = other;
                None
            }
        }
    }
}

struct Session {
    child: Option<Box<dyn Child + Send + Sync>>,
    config_dir: Option<TempDir>,
    _master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    output: mpsc::UnboundedReceiver<Vec<u8>>,
    raw: Vec<u8>,
}

impl Session {
    fn spawn(executable: &Path) -> anyhow::Result<Self> {
        let config_dir = tempfile::tempdir()?;
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 50,
                cols: 1000,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("Couldn't open a terminal for Claude Code")?;
        let mut command = CommandBuilder::new(executable);
        command.arg("setup-token");
        command.env("CLAUDE_CONFIG_DIR", config_dir.path());
        command.env("TERM", "xterm-256color");
        // The UI opens the sign-in page itself.
        command.env("BROWSER", "true");
        let child = pair
            .slave
            .spawn_command(command)
            .context("Couldn't start claude setup-token")?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let (sender, output) = mpsc::unbounded_channel();
        std::thread::spawn(move || {
            let mut buffer = [0; 8192];
            while let Ok(read @ 1..) = reader.read(&mut buffer) {
                if sender.send(buffer[..read].to_vec()).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            child: Some(child),
            config_dir: Some(config_dir),
            _master: pair.master,
            writer,
            output,
            raw: Vec::new(),
        })
    }

    async fn submit(&mut self, code: &str) -> anyhow::Result<String> {
        let sent_at = self.raw.len();
        self.write(code.as_bytes())?;
        tokio::time::sleep(ENTER_DELAY).await;
        self.write(b"\r")?;
        self.wait_for(sent_at, TOKEN_TIMEOUT, |output| {
            oauth_token(output)
                .map(Ok)
                .or_else(|| oauth_error(output).map(Err))
        })
        .await?
        .map_err(anyhow::Error::msg)
    }

    fn write(&mut self, bytes: &[u8]) -> anyhow::Result<()> {
        self.writer
            .write_all(bytes)
            .and_then(|()| self.writer.flush())
            .context("Couldn't send the code to Claude Code")
    }

    /// Reads output until `parse` finds what it wants in the output after `from`.
    async fn wait_for<T>(
        &mut self,
        from: usize,
        timeout: Duration,
        parse: impl Fn(&str) -> Option<T>,
    ) -> anyhow::Result<T> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(found) = parse(&String::from_utf8_lossy(&self.raw[from..])) {
                return Ok(found);
            }
            match tokio::time::timeout_at(deadline, self.output.recv()).await {
                Ok(Some(chunk)) => self.raw.extend_from_slice(&chunk),
                Ok(None) => {
                    let text = screen_text(&String::from_utf8_lossy(&self.raw));
                    bail!(
                        "claude setup-token exited: {}",
                        crate::cli_install::tail(text.trim(), EXIT_TEXT_TAIL)
                    );
                }
                Err(_) => bail!(
                    "claude setup-token didn't respond in {} seconds.",
                    timeout.as_secs()
                ),
            }
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let (Some(mut child), config_dir) = (self.child.take(), self.config_dir.take()) else {
            return;
        };
        // `kill` sleeps while the process handles SIGHUP.
        std::thread::spawn(move || {
            let _ = child.kill();
            let _ = child.wait();
            drop(config_dir);
        });
    }
}

/// The sign-in link, which Claude Code prints as an OSC 8 hyperlink.
fn authorize_url(raw: &str) -> Option<String> {
    raw.split("\x1b]8;").skip(1).find_map(|link| {
        let (_params, rest) = link.split_once(';')?;
        let end = rest.find(['\x07', '\x1b'])?;
        let url = &rest[..end];
        url.contains("oauth/authorize").then(|| url.to_string())
    })
}

/// The visible text with whitespace collapsed. Cursor moves read as spaces, since Claude Code
/// draws spaces that way.
fn screen_text(raw: &str) -> String {
    fn push_space(text: &mut String) {
        if !text.is_empty() && !text.ends_with(' ') {
            text.push(' ');
        }
    }
    let mut text = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(char) = chars.next() {
        match char {
            '\x1b' => match chars.next() {
                Some('[') => {
                    for char in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&char) {
                            break;
                        }
                    }
                    push_space(&mut text);
                }
                Some(']') => {
                    while let Some(char) = chars.next() {
                        if char == '\x07' || (char == '\x1b' && chars.next_if_eq(&'\\').is_some()) {
                            break;
                        }
                    }
                }
                _ => {}
            },
            char if char.is_whitespace() || char.is_control() => push_space(&mut text),
            char => text.push(char),
        }
    }
    text
}

/// The token, once a character after it shows it arrived whole.
fn oauth_token(raw: &str) -> Option<String> {
    let text = screen_text(raw);
    let start = text.find(TOKEN_PREFIX)?;
    let rest = &text[start + TOKEN_PREFIX.len()..];
    let length =
        rest.find(|char: char| !(char.is_ascii_alphanumeric() || matches!(char, '-' | '_')))?;
    (length > 0).then(|| format!("{TOKEN_PREFIX}{}", &rest[..length]))
}

fn oauth_error(raw: &str) -> Option<String> {
    let text = screen_text(raw);
    let (_, rest) = text.split_once("OAuth error:")?;
    let (error, _) = rest.split_once("Press Enter")?;
    Some(error.trim().to_string())
}

#[cfg(test)]
mod tests;
