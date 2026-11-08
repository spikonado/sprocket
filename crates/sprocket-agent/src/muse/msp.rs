//! A client for `muse serve`, which speaks MSP: JSON-RPC 2.0 as newline-delimited JSON over
//! stdio.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};

use crate::cli_session::read_stderr;

const STDERR_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);

/// A JSON-RPC error Muse answered a request with.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct RpcError {
    pub message: String,
    pub data: Value,
}

#[derive(Debug)]
pub enum Incoming {
    Notification { method: String, params: Value },
    Exited(String),
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>>;

/// One `muse serve` process. Dropping it kills the process.
pub struct Msp {
    _child: Child,
    input: mpsc::UnboundedSender<String>,
    pending: Pending,
    next_id: AtomicU64,
}

impl Msp {
    /// Starts `muse serve` and initializes the connection, with Muse's notifications
    /// arriving on the returned channel.
    pub async fn start(
        executable: &Path,
        arguments: impl IntoIterator<Item = impl AsRef<OsStr>>,
        cwd: &Path,
    ) -> anyhow::Result<(Self, mpsc::UnboundedReceiver<Incoming>)> {
        let mut command = Command::new(executable);
        command
            .arg("serve")
            .args(arguments)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, _) in std::env::vars_os() {
            if is_inherited_muse_setting(&key) {
                command.env_remove(key);
            }
        }
        command.env("MUSE_NO_AUTO_UPDATE", "1");
        let mut child = command
            .spawn()
            .with_context(|| format!("start Muse at {}", executable.display()))?;
        let stdin = child.stdin.take().context("Muse has no stdin")?;
        let stdout = child.stdout.take().context("Muse has no stdout")?;
        let stderr = child.stderr.take().context("Muse has no stderr")?;

        let (input, pending_input) = mpsc::unbounded_channel();
        let (incoming, notifications) = mpsc::unbounded_channel();
        let pending = Pending::default();
        tokio::spawn(write_input(stdin, pending_input));
        tokio::spawn(read_output(
            stdout,
            stderr,
            input.downgrade(),
            Arc::clone(&pending),
            incoming,
        ));
        let msp = Self {
            _child: child,
            input,
            pending,
            next_id: AtomicU64::new(1),
        };
        msp.call(
            "initialize",
            json!({
                "clientInfo": { "name": "sprocket", "title": "Sprocket", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": true, "requestedCapabilities": ["sessionMcp"] },
            }),
        )
        .await
        .context("Muse didn't start its protocol server")?;
        msp.notify("initialized", Value::Null);
        Ok((msp, notifications))
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id, sender);
        }
        let mut request = json!({ "jsonrpc": "2.0", "id": id, "method": method });
        if !params.is_null() {
            request["params"] = params;
        }
        let _ = self.input.send(request.to_string());
        receiver.await.unwrap_or_else(|_| {
            Err(RpcError {
                message: "Muse stopped.".to_string(),
                data: Value::Null,
            })
        })
    }

    pub fn notify(&self, method: &str, params: Value) {
        let mut notification = json!({ "jsonrpc": "2.0", "method": method });
        if !params.is_null() {
            notification["params"] = params;
        }
        let _ = self.input.send(notification.to_string());
    }
}

/// A new MSP command ID. Muse takes UUIDv7s.
pub fn command_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Settings from the user's own environment, which could change the account, endpoint, or
/// behavior Sprocket runs with. Muse reads the user's saved login and settings from disk.
fn is_inherited_muse_setting(key: &OsStr) -> bool {
    let key = key.to_string_lossy().to_ascii_uppercase();
    key.starts_with("MUSE_") || key.starts_with("META_")
}

async fn write_input(mut stdin: ChildStdin, mut input: mpsc::UnboundedReceiver<String>) {
    while let Some(mut line) = input.recv().await {
        line.push('\n');
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
            return;
        }
    }
}

async fn read_output(
    stdout: ChildStdout,
    stderr: ChildStderr,
    input: mpsc::WeakUnboundedSender<String>,
    pending: Pending,
    incoming: mpsc::UnboundedSender<Incoming>,
) {
    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let stderr_reader = tokio::spawn(read_stderr(stderr, Arc::clone(&stderr_tail)));
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(mut message @ Value::Object(_)) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let method = message["method"].as_str().map(str::to_string);
        match (method, message["id"].as_u64()) {
            (Some(method), _) if !message["id"].is_null() => {
                // Muse asks for nothing a non-interactive session can answer.
                if let Some(input) = input.upgrade() {
                    let reply = json!({
                        "jsonrpc": "2.0",
                        "id": message["id"],
                        "error": { "code": -32601, "message": format!("Sprocket does not handle {method}.") },
                    });
                    let _ = input.send(reply.to_string());
                }
            }
            (Some(method), _) => {
                let _ = incoming.send(Incoming::Notification {
                    method,
                    params: message["params"].take(),
                });
            }
            (None, Some(id)) => {
                let Some(sender) = pending.lock().ok().and_then(|mut map| map.remove(&id)) else {
                    continue;
                };
                let error = message["error"].take();
                let result = if error.is_null() {
                    Ok(message["result"].take())
                } else {
                    Err(RpcError {
                        message: error["message"].as_str().unwrap_or_default().to_string(),
                        data: error["data"].clone(),
                    })
                };
                let _ = sender.send(result);
            }
            (None, None) => {}
        }
    }
    let _ = tokio::time::timeout(STDERR_DRAIN_TIMEOUT, stderr_reader).await;
    let reason = stderr_tail
        .lock()
        .map(|tail| tail.trim().to_string())
        .unwrap_or_default();
    if let Ok(mut pending) = pending.lock() {
        pending.clear();
    }
    let _ = incoming.send(Incoming::Exited(if reason.is_empty() {
        "it exited without an error message".to_string()
    } else {
        reason
    }));
}
