use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use convex::Value;
use serde::Deserialize;
use sprocket_transcript::TranscriptStore;
use sprocket_workspace::{CommandHistory, CommandOutput, history_path};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader, BufWriter};

use crate::command_sessions::ThreadCommandSessions;
use crate::native_auth::NativeAuthManager;
use crate::transcript_client::UserConvexClient;

const CHUNK_BYTES: usize = 128 * 1024;

type IdleSessions = HashMap<PathBuf, u64>;

#[derive(Clone, Copy)]
enum SyncOutcome {
    Completed,
    RunningCaughtUp,
    Pending,
}

async fn sync_when_changed(
    idle: &mut IdleSessions,
    path: &Path,
    history: &CommandHistory,
    sync: impl Future<Output = Result<SyncOutcome>>,
) -> Result<bool> {
    let size = tokio::fs::metadata(&history.result.events_path)
        .await?
        .len();
    if history.result.running && idle.get(path) == Some(&size) {
        return Ok(false);
    }
    idle.remove(path);
    match sync.await? {
        SyncOutcome::Completed => Ok(true),
        SyncOutcome::RunningCaughtUp => {
            idle.insert(path.to_path_buf(), size);
            Ok(false)
        }
        SyncOutcome::Pending => Ok(false),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCommand {
    command: String,
    workdir: String,
    machine_id: String,
    result: CommandOutput,
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u64")]
    events_bytes: u64,
}

fn session_args(thread_id: &str, session_id: &str) -> BTreeMap<String, Value> {
    BTreeMap::from([
        ("threadId".into(), thread_id.to_string().into()),
        ("sessionId".into(), session_id.to_string().into()),
    ])
}

fn snapshot_value(history: &CommandHistory, running: bool) -> Value {
    let mut result = BTreeMap::from([
        (
            "success".into(),
            Value::Boolean(history.result.success && !running),
        ),
        ("running".into(), Value::Boolean(running)),
        ("timedOut".into(), Value::Boolean(history.result.timed_out)),
        ("output".into(), history.result.output.clone().into()),
    ]);
    if let Some(code) = history.result.exit_code {
        result.insert("exitCode".into(), Value::Float64(f64::from(code)));
    }
    if let Some(error) = &history.result.error {
        result.insert("error".into(), error.clone().into());
    }
    Value::Object(BTreeMap::from([
        ("command".into(), history.command.clone().into()),
        ("workdir".into(), history.workdir.clone().into()),
        ("machineId".into(), history.machine_id.clone().into()),
        ("result".into(), Value::Object(result)),
    ]))
}

async fn log_chunks(path: &str, mut offset: u64) -> Result<Vec<Value>> {
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut chunks = Vec::new();
    for _ in 0..2 {
        let mut bytes = vec![0; CHUNK_BYTES];
        let read = file.read(&mut bytes).await?;
        if read == 0 {
            break;
        }
        bytes.truncate(read);
        chunks.push(Value::Object(BTreeMap::from([
            ("offset".into(), Value::Float64(offset as f64)),
            ("bytes".into(), Value::Bytes(bytes)),
        ])));
        offset += read as u64;
    }
    Ok(chunks)
}

async fn sync_session(
    client: &UserConvexClient,
    session_id: &str,
    history: &CommandHistory,
) -> Result<SyncOutcome> {
    let mut args = session_args(&history.thread_id, session_id);
    let remote: Option<RemoteCommand> = client.query("commands:get", args.clone()).await?;
    let events_offset = match remote {
        Some(remote) if !remote.result.running => return Ok(SyncOutcome::Completed),
        Some(remote) => remote.events_bytes,
        None => 0,
    };
    let chunks = log_chunks(&history.result.events_path, events_offset).await?;
    let caught_up = chunks.is_empty();
    let completed = caught_up && !history.result.running;
    args.insert("snapshot".into(), snapshot_value(history, !completed));
    args.insert("chunks".into(), Value::Array(chunks));
    let _: serde_json::Value = client.mutate("commands:sync", args).await?;
    Ok(if completed {
        SyncOutcome::Completed
    } else if caught_up {
        SyncOutcome::RunningCaughtUp
    } else {
        SyncOutcome::Pending
    })
}

pub fn spawn(
    store: Arc<TranscriptStore>,
    registry: Arc<ThreadCommandSessions>,
    auth: Arc<NativeAuthManager>,
    deployment: String,
    machine_id: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut idle = IdleSessions::new();
        loop {
            if let Err(error) = sync_directory(
                &store,
                &registry,
                &auth,
                &deployment,
                &machine_id,
                &mut idle,
            )
            .await
            {
                tracing::warn!("command sync will retry: {error:#}");
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    })
}

pub async fn flush(
    store: &TranscriptStore,
    registry: &ThreadCommandSessions,
    auth: &Arc<NativeAuthManager>,
    deployment: &str,
    machine_id: &str,
) -> Result<()> {
    let mut idle = IdleSessions::new();
    while !sync_directory(store, registry, auth, deployment, machine_id, &mut idle).await? {}
    Ok(())
}

async fn sync_directory(
    store: &TranscriptStore,
    registry: &ThreadCommandSessions,
    auth: &Arc<NativeAuthManager>,
    deployment: &str,
    machine_id: &str,
    idle: &mut IdleSessions,
) -> Result<bool> {
    let mut complete = true;
    let mut users = match tokio::fs::read_dir(store.root()).await {
        Ok(users) => users,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error.into()),
    };
    while let Some(user) = users.next_entry().await? {
        if !user.file_type().await?.is_dir() {
            continue;
        }
        let mut threads = tokio::fs::read_dir(user.path()).await?;
        let mut client = None;
        while let Some(thread) = threads.next_entry().await? {
            let directory = thread.path().join("command-logs");
            let mut records = match tokio::fs::read_dir(directory.join("sessions")).await {
                Ok(records) => records,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            while let Some(record) = records.next_entry().await? {
                let path = record.path();
                if path.extension().is_none_or(|extension| extension != "json") {
                    continue;
                }
                let result = tokio::time::timeout(
                    Duration::from_secs(15),
                    sync_record(
                        &path,
                        &directory,
                        registry,
                        auth,
                        deployment,
                        machine_id,
                        &mut client,
                        idle,
                    ),
                )
                .await
                .context("command sync timed out")
                .and_then(|result| result);
                match result {
                    Ok(synced) => complete &= synced,
                    Err(error) => {
                        complete = false;
                        tracing::warn!(
                            "command record {} sync will retry: {error:#}",
                            path.display()
                        );
                    }
                }
            }
        }
    }
    Ok(complete)
}

async fn sync_record(
    path: &Path,
    directory: &Path,
    registry: &ThreadCommandSessions,
    auth: &Arc<NativeAuthManager>,
    deployment: &str,
    machine_id: &str,
    client: &mut Option<UserConvexClient>,
    idle: &mut IdleSessions,
) -> Result<bool> {
    if tokio::fs::try_exists(path.with_extension("synced")).await? {
        idle.remove(path);
        return Ok(true);
    }
    let mut history: CommandHistory = serde_json::from_slice(&tokio::fs::read(path).await?)?;
    if history.machine_id != machine_id || history.user_id.is_empty() {
        return Ok(true);
    }
    if auth.require_user(&history.user_id).await.is_err() {
        return Ok(true);
    }
    let session_id = path
        .file_stem()
        .context("session record has no ID")?
        .to_str()
        .context("invalid session ID")?;
    match registry.get(&history.user_id, &history.thread_id).await {
        Some(manager) => manager.history_snapshot(session_id, &mut history).await?,
        None => history.recover_if_running(directory, session_id).await?,
    }
    let completed = sync_when_changed(idle, path, &history, async {
        let client = match client {
            Some(client) => client,
            None => client.insert(
                UserConvexClient::connect_with_fetcher(
                    deployment,
                    auth.auth_token_fetcher_for_user(history.user_id.clone()),
                )
                .await?,
            ),
        };
        sync_session(client, session_id, &history).await
    })
    .await?;
    if completed {
        tokio::fs::write(path.with_extension("synced"), b"").await?;
    }
    Ok(completed)
}

#[derive(Deserialize)]
struct RemoteChunk {
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u64")]
    offset: u64,
    bytes: Vec<u8>,
}

#[derive(Deserialize)]
struct CapturedEvent {
    sequence: u64,
    bytes: Vec<u8>,
}

async fn rebuild_output(events: &Path, output: &Path, allow_partial: bool) -> Result<()> {
    let mut reader = BufReader::new(tokio::fs::File::open(events).await?);
    let temporary =
        tempfile::NamedTempFile::new_in(output.parent().context("log has no directory")?)?;
    let (file, temporary_path) = temporary.into_parts();
    let mut file = BufWriter::new(tokio::fs::File::from_std(file));
    let mut line = Vec::new();
    let mut sequence = 0;
    loop {
        line.clear();
        let read = (&mut reader)
            .take(64 * 1024)
            .read_until(b'\n', &mut line)
            .await?;
        if read == 0 {
            break;
        }
        if line.last() != Some(&b'\n') {
            if read == 64 * 1024 || !allow_partial {
                bail!("command event log has an incomplete or oversized record");
            }
            break;
        }
        let event: CapturedEvent =
            serde_json::from_slice(&line).context("invalid command event")?;
        if event.sequence != sequence {
            bail!("command event log has an unexpected sequence");
        }
        file.write_all(&event.bytes).await?;
        sequence += 1;
    }
    file.flush().await?;
    file.get_ref().sync_all().await?;
    drop(file);
    temporary_path.persist(output)?;
    Ok(())
}

async fn download_log(
    client: &UserConvexClient,
    args: &BTreeMap<String, Value>,
    path: &Path,
    length: u64,
) -> Result<()> {
    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).await?;
    let mut offset = file.metadata().await?.len();
    if offset > length {
        bail!("local command log is longer than its remote source");
    }
    while offset < length {
        let mut args = args.clone();
        args.insert("offset".into(), Value::Float64(offset as f64));
        let chunks: Vec<RemoteChunk> = client.query("commands:getLogChunks", args).await?;
        if chunks.is_empty() {
            bail!("remote command log is incomplete");
        }
        for chunk in chunks {
            if offset >= length {
                break;
            }
            if chunk.offset > offset || chunk.offset + chunk.bytes.len() as u64 <= offset {
                bail!("remote command log has an unexpected offset");
            }
            let start = (offset - chunk.offset) as usize;
            let end = chunk.bytes.len().min(start + (length - offset) as usize);
            file.write_all(&chunk.bytes[start..end]).await?;
            offset += (end - start) as u64;
        }
    }
    file.flush().await?;
    file.sync_all().await?;
    Ok(())
}

pub async fn fetch(
    deployment: &str,
    auth: &Arc<NativeAuthManager>,
    user_id: &str,
    thread_id: &str,
    session_id: &str,
    directory: &Path,
) -> Result<Option<CommandHistory>> {
    let client = UserConvexClient::connect_with_fetcher(
        deployment,
        auth.auth_token_fetcher_for_user(user_id.to_string()),
    )
    .await?;
    let args = session_args(thread_id, session_id);
    let Some(mut remote): Option<RemoteCommand> =
        client.query("commands:get", args.clone()).await?
    else {
        return Ok(None);
    };
    let id = uuid::Uuid::parse_str(session_id)?;
    let logs = directory.join(format!("command-{id}"));
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(&logs).await?;
    let output = logs.join("output.log");
    let events = logs.join("events.jsonl");
    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);
    drop(options.open(&output).await?);
    download_log(&client, &args, &events, remote.events_bytes).await?;
    rebuild_output(
        &events,
        &output,
        remote.result.running || !remote.result.success,
    )
    .await?;
    if remote.result.running {
        remote.result.error = Some("command belongs to another machine; this is its last synced output, not a live process observation".into());
    }
    let history = CommandHistory {
        user_id: user_id.into(),
        thread_id: thread_id.into(),
        machine_id: remote.machine_id,
        command: remote.command,
        workdir: remote.workdir,
        max_output_chars: 20_000,
        result: CommandOutput {
            complete_log_path: output.to_string_lossy().into_owned(),
            events_path: events.to_string_lossy().into_owned(),
            ..remote.result
        },
    };
    history.save(&history_path(directory, session_id)?).await?;
    Ok(Some(history))
}

#[cfg(test)]
mod tests;
