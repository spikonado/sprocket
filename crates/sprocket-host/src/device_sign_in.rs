use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

/// Device codes from GitHub and Vercel expire well before this.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// The CLI's error can still be in the pipes when its exit is noticed.
const FINAL_OUTPUT_WAIT: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SignInStatus {
    Idle,
    Starting,
    Waiting { url: String, code: Option<String> },
    Failed { error: String },
}

struct Session {
    id: u64,
    status: SignInStatus,
    task: Option<AbortHandle>,
}

/// Runs CLI logins that print a device URL and code, such as `gh auth login --web` and
/// `vercel login`, so the user can finish them from any device.
#[derive(Default)]
pub struct DeviceSignIns {
    sessions: Mutex<HashMap<String, Session>>,
    next_id: AtomicU64,
}

impl DeviceSignIns {
    pub fn status(&self, key: &str) -> SignInStatus {
        self.lock()
            .get(key)
            .map_or(SignInStatus::Idle, |session| session.status.clone())
    }

    /// Starts `command` unless a sign-in for `key` is already running, and calls
    /// `signed_in` once it exits successfully.
    pub fn start(
        self: &Arc<Self>,
        key: &str,
        mut command: Command,
        signed_in: impl FnOnce() + Send + 'static,
    ) -> SignInStatus {
        let mut sessions = self.lock();
        if let Some(session) = sessions.get(key)
            && matches!(
                session.status,
                SignInStatus::Starting | SignInStatus::Waiting { .. }
            )
        {
            return session.status.clone();
        }
        let spawned = command
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (status, task) = match spawned {
            Ok(child) => (
                SignInStatus::Starting,
                Some(
                    tokio::spawn(Arc::clone(self).watch(key.to_string(), id, child, signed_in))
                        .abort_handle(),
                ),
            ),
            Err(error) => (
                SignInStatus::Failed {
                    error: format!("Couldn't start signing in: {error}"),
                },
                None,
            ),
        };
        sessions.insert(
            key.to_string(),
            Session {
                id,
                status: status.clone(),
                task,
            },
        );
        status
    }

    /// Aborting the watcher drops the child, which `kill_on_drop` stops.
    pub fn cancel(&self, key: &str) -> SignInStatus {
        if let Some(session) = self.lock().remove(key)
            && let Some(task) = session.task
        {
            task.abort();
        }
        SignInStatus::Idle
    }

    async fn watch(
        self: Arc<Self>,
        key: String,
        id: u64,
        mut child: tokio::process::Child,
        signed_in: impl FnOnce(),
    ) {
        let (lines, mut output) = mpsc::unbounded_channel();
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(forward_lines(stdout, lines.clone()));
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(forward_lines(stderr, lines));
        }
        let mut prompt = Prompt::default();
        let mut last_line = None;
        let exit = tokio::time::timeout(SIGN_IN_TIMEOUT, async {
            loop {
                tokio::select! {
                    Some(line) = output.recv() => {
                        if prompt.read(&line) && let Some(status) = prompt.status() {
                            self.update(&key, id, status);
                        }
                        keep_last_line(&mut last_line, &line);
                    }
                    exit = child.wait() => return exit,
                }
            }
        })
        .await;
        let error = match exit {
            Ok(Ok(status)) if status.success() => {
                self.remove(&key, id);
                signed_in();
                return;
            }
            Ok(Ok(status)) => {
                while let Ok(Some(line)) =
                    tokio::time::timeout(FINAL_OUTPUT_WAIT, output.recv()).await
                {
                    keep_last_line(&mut last_line, &line);
                }
                last_line.unwrap_or_else(|| format!("Signing in exited with {status}."))
            }
            Ok(Err(error)) => format!("Signing in failed: {error}"),
            Err(_) => "Signing in timed out. Try again.".to_string(),
        };
        self.update(&key, id, SignInStatus::Failed { error });
    }

    fn update(&self, key: &str, id: u64, status: SignInStatus) {
        if let Some(session) = self.lock().get_mut(key)
            && session.id == id
        {
            session.status = status;
        }
    }

    fn remove(&self, key: &str, id: u64) {
        let mut sessions = self.lock();
        if sessions.get(key).is_some_and(|session| session.id == id) {
            sessions.remove(key);
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Session>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn keep_last_line(last_line: &mut Option<String>, line: &str) {
    let line = line.trim();
    if !line.is_empty() {
        *last_line = Some(line.to_string());
    }
}

async fn forward_lines(stream: impl AsyncRead + Unpin, lines: mpsc::UnboundedSender<String>) {
    let mut reader = BufReader::new(stream).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        if lines.send(line).is_err() {
            return;
        }
    }
}

#[derive(Default)]
struct Prompt {
    url: Option<String>,
    code: Option<String>,
}

impl Prompt {
    /// Reads `gh`'s "one-time code: XXXX-XXXX" and URL lines, or a URL that carries
    /// the code as `user_code`, as `vercel login` prints. Returns whether anything changed.
    fn read(&mut self, line: &str) -> bool {
        let mut changed = false;
        for word in line.split_whitespace() {
            let word = word.trim_end_matches(['.', ',', ')']);
            if self.url.is_none() && word.starts_with("https://") {
                if self.code.is_none() {
                    self.code = url::Url::parse(word).ok().and_then(|url| {
                        url.query_pairs()
                            .find(|(name, _)| name == "user_code")
                            .map(|(_, code)| code.into_owned())
                    });
                }
                self.url = Some(word.to_string());
                changed = true;
            } else if self.code.is_none() && is_device_code(word) {
                self.code = Some(word.to_string());
                changed = true;
            }
        }
        changed
    }

    fn status(&self) -> Option<SignInStatus> {
        Some(SignInStatus::Waiting {
            url: self.url.clone()?,
            code: self.code.clone(),
        })
    }
}

fn is_device_code(word: &str) -> bool {
    let half = |part: &str| {
        part.len() == 4
            && part
                .chars()
                .all(|character| character.is_ascii_uppercase() || character.is_ascii_digit())
    };
    word.split_once('-')
        .is_some_and(|(first, second)| half(first) && half(second))
}

#[cfg(test)]
mod tests;
