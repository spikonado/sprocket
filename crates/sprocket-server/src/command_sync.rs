use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use convex::Value;
use serde::Deserialize;
use sprocket_agent::TranscriptStore;
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

pub(crate) fn spawn(
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

pub(crate) async fn flush(
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
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn event(sequence: u64, channel: &str, bytes: &[u8]) -> Vec<u8> {
        let mut encoded = serde_json::to_vec(&serde_json::json!({
            "sequence": sequence,
            "timestampMs": 123,
            "channel": channel,
            "bytes": bytes,
        }))
        .unwrap();
        encoded.push(b'\n');
        encoded
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn captured_command_events_rebuild_the_original_log() {
        use sprocket_workspace::{
            CommandSessionManager, WorkspaceCancellation, default_command_shell,
        };

        let directory = tempfile::tempdir().unwrap();
        let sessions =
            CommandSessionManager::new(directory.path().into(), directory.path().join("logs"));
        let captured = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "printf '\\033[32mready\\000\\377\\n'; printf 'warning\\n' >&2",
                ".",
                &default_command_shell(),
                None,
                5_000,
                20_000,
            )
            .await
            .unwrap();
        assert!(captured.result.success);
        let output = directory.path().join("rebuilt.log");
        rebuild_output(Path::new(&captured.result.events_path), &output, false)
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(output).await.unwrap(),
            tokio::fs::read(captured.result.complete_log_path)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn downloaded_events_rebuild_exact_combined_output_across_partial_batches() {
        let directory = tempfile::tempdir().unwrap();
        let events = directory.path().join("events.jsonl");
        let output = directory.path().join("output.log");
        tokio::fs::write(&events, b"").await.unwrap();
        rebuild_output(&events, &output, false).await.unwrap();
        assert_eq!(tokio::fs::read(&output).await.unwrap(), b"");
        let first = event(0, "stdout", b"\x1b[32mready\x00\xff\n");
        let second = event(1, "stderr", b"warning\n");
        let third = event(2, "stdout", "done \u{1f680}\n".as_bytes());
        let mut downloaded = first.clone();
        downloaded.extend_from_slice(&second[..second.len() / 2]);
        tokio::fs::write(&events, &downloaded).await.unwrap();
        rebuild_output(&events, &output, true).await.unwrap();
        assert_eq!(
            tokio::fs::read(&output).await.unwrap(),
            b"\x1b[32mready\x00\xff\n"
        );

        downloaded.extend_from_slice(&second[second.len() / 2..]);
        downloaded.extend_from_slice(&third);
        tokio::fs::write(&events, &downloaded).await.unwrap();
        let expected = [
            b"\x1b[32mready\x00\xff\nwarning\n".as_slice(),
            "done \u{1f680}\n".as_bytes(),
        ]
        .concat();
        for _ in 0..2 {
            rebuild_output(&events, &output, false).await.unwrap();
            assert_eq!(tokio::fs::read(&output).await.unwrap(), expected);
        }
        assert_eq!(tokio::fs::read(&events).await.unwrap(), downloaded);
    }

    #[tokio::test]
    async fn invalid_events_preserve_the_previous_output() {
        let directory = tempfile::tempdir().unwrap();
        let events = directory.path().join("events.jsonl");
        let output = directory.path().join("output.log");
        tokio::fs::write(&output, b"previous output").await.unwrap();
        let incomplete = event(0, "stdout", b"unfinished");
        for bytes in [
            event(1, "stdout", b"sequence gap"),
            b"not JSON\n".to_vec(),
            incomplete[..incomplete.len() - 1].to_vec(),
        ] {
            tokio::fs::write(&events, bytes).await.unwrap();
            assert!(rebuild_output(&events, &output, false).await.is_err());
            assert_eq!(tokio::fs::read(&output).await.unwrap(), b"previous output");
        }
    }

    async fn running_history(directory: &Path) -> CommandHistory {
        let output = directory.join("output.log");
        let events = directory.join("events.jsonl");
        tokio::fs::write(&output, b"").await.unwrap();
        tokio::fs::write(&events, b"").await.unwrap();
        CommandHistory {
            user_id: "user".into(),
            thread_id: "thread".into(),
            machine_id: "machine".into(),
            command: "build".into(),
            workdir: "/workspace".into(),
            max_output_chars: 20_000,
            result: CommandOutput {
                exit_code: None,
                success: false,
                running: true,
                timed_out: false,
                output: String::new(),
                complete_log_path: output.to_string_lossy().into_owned(),
                events_path: events.to_string_lossy().into_owned(),
                error: None,
            },
        }
    }

    async fn acknowledged_sync(calls: &AtomicUsize, outcome: SyncOutcome) -> Result<SyncOutcome> {
        calls.fetch_add(1, Ordering::Relaxed);
        Ok(outcome)
    }

    #[tokio::test]
    async fn idle_sessions_sync_again_for_events_and_completion() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.json");
        let mut history = running_history(directory.path()).await;
        let mut idle = IdleSessions::new();
        let calls = AtomicUsize::new(0);

        for _ in 0..3 {
            assert!(
                !sync_when_changed(
                    &mut idle,
                    &path,
                    &history,
                    acknowledged_sync(&calls, SyncOutcome::RunningCaughtUp),
                )
                .await
                .unwrap()
            );
        }
        assert_eq!(calls.load(Ordering::Relaxed), 1);

        tokio::fs::write(&history.result.events_path, b"new event")
            .await
            .unwrap();
        for _ in 0..2 {
            sync_when_changed(
                &mut idle,
                &path,
                &history,
                acknowledged_sync(&calls, SyncOutcome::RunningCaughtUp),
            )
            .await
            .unwrap();
        }
        assert_eq!(calls.load(Ordering::Relaxed), 2);

        history.result.running = false;
        history.result.exit_code = Some(0);
        history.result.success = true;
        assert!(
            sync_when_changed(
                &mut idle,
                &path,
                &history,
                acknowledged_sync(&calls, SyncOutcome::Completed),
            )
            .await
            .unwrap()
        );
        assert_eq!(calls.load(Ordering::Relaxed), 3);
        assert!(idle.is_empty());
    }

    #[tokio::test]
    async fn pending_batches_and_failed_uploads_retry_until_acknowledged() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.json");
        let history = running_history(directory.path()).await;
        let mut idle = IdleSessions::new();
        let calls = AtomicUsize::new(0);

        for _ in 0..2 {
            sync_when_changed(
                &mut idle,
                &path,
                &history,
                acknowledged_sync(&calls, SyncOutcome::Pending),
            )
            .await
            .unwrap();
        }
        let failed = sync_when_changed(&mut idle, &path, &history, async {
            calls.fetch_add(1, Ordering::Relaxed);
            bail!("upload failed");
        })
        .await;
        assert!(failed.is_err());

        for _ in 0..2 {
            sync_when_changed(
                &mut idle,
                &path,
                &history,
                acknowledged_sync(&calls, SyncOutcome::RunningCaughtUp),
            )
            .await
            .unwrap();
        }
        assert_eq!(calls.load(Ordering::Relaxed), 4);

        let mut restarted = IdleSessions::new();
        sync_when_changed(
            &mut restarted,
            &path,
            &history,
            acknowledged_sync(&calls, SyncOutcome::RunningCaughtUp),
        )
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 5);
    }

    #[tokio::test]
    async fn malformed_record_remains_pending_for_retry() {
        let directory = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(directory.path().to_path_buf());
        let records = store
            .thread_dir("user", "thread")
            .join("command-logs/sessions");
        tokio::fs::create_dir_all(&records).await.unwrap();
        let path = records.join(format!("{}.json", uuid::Uuid::new_v4()));
        tokio::fs::write(&path, b"interrupted write").await.unwrap();
        let auth = NativeAuthManager::configured_for_test(
            crate::native_auth::NativeAuthConfig {
                workos_client_id: "test".into(),
            },
            "http://localhost/callback".into(),
        );
        let registry = ThreadCommandSessions::default();
        assert!(
            !sync_directory(
                &store,
                &registry,
                &auth,
                "http://localhost",
                "machine",
                &mut IdleSessions::new(),
            )
            .await
            .unwrap()
        );
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"interrupted write");
        assert!(!path.with_extension("synced").exists());
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
            let chunks = log_chunks(path, offset).await.unwrap();
            assert_eq!(chunks, log_chunks(path, offset).await.unwrap());
            assert!(!chunks.is_empty());
            assert!(chunks.len() <= 2);

            for chunk in chunks {
                let Value::Object(mut chunk) = chunk else {
                    panic!("expected a log chunk");
                };
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
            log_chunks(path, bytes.len() as u64)
                .await
                .unwrap()
                .is_empty()
        );
    }
}
