use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use convex::Value;
use serde::Deserialize;
use sprocket_agent::TranscriptStore;
use sprocket_workspace::{CommandHistory, CommandOutput, CommandSessionManager, history_path};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::command_sessions::ThreadCommandSessions;
use crate::native_auth::NativeAuthManager;
use crate::transcript_client::UserConvexClient;

const CHUNK_BYTES: usize = 128 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCommand {
    command: String,
    workdir: String,
    machine_id: String,
    result: CommandOutput,
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u64")]
    output_bytes: u64,
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

async fn log_chunks(path: &str, stream: &str, mut offset: u64) -> Result<Vec<Value>> {
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
            ("stream".into(), stream.to_string().into()),
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
) -> Result<bool> {
    let mut args = session_args(&history.thread_id, session_id);
    let remote: Option<RemoteCommand> = client.query("commands:get", args.clone()).await?;
    let (output_offset, events_offset) = match remote {
        Some(remote) if !remote.result.running => return Ok(true),
        Some(remote) => (remote.output_bytes, remote.events_bytes),
        None => (0, 0),
    };
    let mut chunks = log_chunks(&history.result.complete_log_path, "output", output_offset).await?;
    chunks.extend(log_chunks(&history.result.events_path, "events", events_offset).await?);
    let completed = chunks.is_empty() && !history.result.running;
    args.insert("snapshot".into(), snapshot_value(history, !completed));
    args.insert("chunks".into(), Value::Array(chunks));
    let _: serde_json::Value = client.mutate("commands:sync", args).await?;
    Ok(completed)
}

pub(crate) fn spawn(
    store: Arc<TranscriptStore>,
    registry: Arc<ThreadCommandSessions>,
    auth: Arc<NativeAuthManager>,
    deployment: String,
    machine_id: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if let Err(error) =
                sync_directory(&store, &registry, &auth, &deployment, &machine_id).await
            {
                tracing::warn!("command sync will retry: {error:#}");
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    })
}

pub(crate) async fn flush(
    store: &TranscriptStore,
    registry: &ThreadCommandSessions,
    auth: &Arc<NativeAuthManager>,
    deployment: &str,
    machine_id: &str,
) -> Result<()> {
    while !sync_directory(store, registry, auth, deployment, machine_id).await? {}
    Ok(())
}

async fn sync_directory(
    store: &TranscriptStore,
    registry: &ThreadCommandSessions,
    auth: &Arc<NativeAuthManager>,
    deployment: &str,
    machine_id: &str,
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
) -> Result<bool> {
    if tokio::fs::try_exists(path.with_extension("synced")).await? {
        return Ok(true);
    }
    let history: CommandHistory = serde_json::from_slice(&tokio::fs::read(path).await?)?;
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
    let manager = registry
        .get(&history.user_id, &history.thread_id)
        .await
        .unwrap_or_else(|| CommandSessionManager::new(PathBuf::new(), directory.to_path_buf()));
    let snapshot = manager.history_snapshot(session_id).await?;
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
    let completed = sync_session(client, session_id, &snapshot).await?;
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

async fn download_log(
    client: &UserConvexClient,
    args: &BTreeMap<String, Value>,
    stream: &str,
    path: &Path,
    length: u64,
) -> Result<()> {
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await?;
    let mut offset = file.metadata().await?.len();
    if offset > length {
        bail!("local command log is longer than its remote source");
    }
    while offset < length {
        let mut args = args.clone();
        args.insert("stream".into(), stream.to_string().into());
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

pub(crate) async fn fetch(
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
    let logs = directory.join("remote").join(id.to_string());
    tokio::fs::create_dir_all(&logs).await?;
    let output = logs.join("output.log");
    let events = logs.join("events.jsonl");
    download_log(&client, &args, "output", &output, remote.output_bytes).await?;
    download_log(&client, &args, "events", &events, remote.events_bytes).await?;
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
mod tests {
    use super::*;

    #[tokio::test]
    async fn malformed_records_remain_pending_until_individually_marked_synced() {
        let directory = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(directory.path().to_path_buf());
        let mut paths = Vec::new();
        for thread_id in ["first-thread", "second-thread"] {
            let records = store
                .thread_dir("user", thread_id)
                .join("command-logs/sessions");
            tokio::fs::create_dir_all(&records).await.unwrap();
            let path = records.join(format!("{}.json", uuid::Uuid::new_v4()));
            tokio::fs::write(&path, b"interrupted write").await.unwrap();
            paths.push(path);
        }
        let auth = NativeAuthManager::configured_for_test(
            crate::native_auth::NativeAuthConfig {
                workos_client_id: "test".into(),
            },
            "http://localhost/callback".into(),
        );
        let registry = ThreadCommandSessions::default();
        for path in &paths {
            assert!(
                !sync_directory(&store, &registry, &auth, "http://localhost", "machine")
                    .await
                    .unwrap()
            );
            assert_eq!(tokio::fs::read(path).await.unwrap(), b"interrupted write");
            assert!(!path.with_extension("synced").exists());
            tokio::fs::write(path.with_extension("synced"), b"")
                .await
                .unwrap();
        }
        assert!(
            sync_directory(&store, &registry, &auth, "http://localhost", "machine")
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn log_batches_resume_in_order_without_changing_retry_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("output.log");
        let bytes: Vec<u8> = (0..CHUNK_BYTES * 5 + 17).map(|index| index as u8).collect();
        tokio::fs::write(&path, &bytes).await.unwrap();
        let path = path.to_str().unwrap();
        let mut downloaded = bytes[..23].to_vec();

        while downloaded.len() < bytes.len() {
            let offset = downloaded.len() as u64;
            let chunks = log_chunks(path, "output", offset).await.unwrap();
            assert_eq!(chunks, log_chunks(path, "output", offset).await.unwrap());
            assert!(!chunks.is_empty());
            assert!(chunks.len() <= 2);

            for chunk in chunks {
                let Value::Object(mut chunk) = chunk else {
                    panic!("expected a log chunk");
                };
                assert_eq!(chunk.remove("stream"), Some("output".into()));
                assert_eq!(
                    chunk.remove("offset"),
                    Some(Value::Float64(downloaded.len() as f64))
                );
                let Some(Value::Bytes(chunk)) = chunk.remove("bytes") else {
                    panic!("expected log bytes");
                };
                assert!(!chunk.is_empty());
                assert!(chunk.len() <= CHUNK_BYTES);
                downloaded.extend(chunk);
            }
        }

        assert_eq!(downloaded, bytes);
        assert!(
            log_chunks(path, "output", bytes.len() as u64)
                .await
                .unwrap()
                .is_empty()
        );
    }
}
