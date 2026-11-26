use super::*;
use crate::types::{TranscriptPartKind, TranscriptPromptBody};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::AsyncReadExt;

fn attachment(id: &str, size: u64) -> TranscriptAttachmentMeta {
    TranscriptAttachmentMeta {
        file_id: Some(format!("file-{id}")),
        name: "../notes.txt".into(),
        media_type: "application/octet-stream".into(),
        size,
        local_path: None,
    }
}

fn file_id(meta: &TranscriptAttachmentMeta) -> &str {
    meta.file_id.as_deref().unwrap()
}

fn cached_path(store: &TranscriptStore, meta: &TranscriptAttachmentMeta) -> PathBuf {
    store.attachment_path("user", "thread", file_id(meta), &meta.name)
}

async fn unreachable_url() -> anyhow::Result<String> {
    anyhow::bail!("resolver must not be called")
}

fn prompt_part(number: u32, attachments: Vec<TranscriptAttachmentMeta>) -> TranscriptPart {
    TranscriptPart {
        number,
        source_key: format!("prompt:{number}"),
        kind: TranscriptPartKind::Prompt,
        run_id: "run".into(),
        created_at: None,
        prompt: Some(TranscriptPromptBody {
            text: "Continue".into(),
            image_uploads: attachments,
            hidden: None,
        }),
        completion: None,
        tool: None,
    }
}

async fn serve(status: u16, body: &str) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/attachment", listener.local_addr().unwrap());
    let response = format!(
        "HTTP/1.1 {status} Result\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let read = stream.read(&mut request).await.unwrap();
        assert!(read > 0);
        stream.write_all(response.as_bytes()).await.unwrap();
    });
    (url, server)
}

#[tokio::test]
async fn cached_attachments_skip_url_resolution_and_keep_canonical_paths_and_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into());
    let mut attachments = Vec::new();
    for id in ["one", "two"] {
        let mut meta = attachment(id, 4);
        meta.local_path = Some("stale-local-path".into());
        let path = cached_path(&store, &meta);
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(path, b"data").await.unwrap();
        attachments.push(meta);
    }
    let mut parts = vec![prompt_part(7, attachments)];
    cache_prompt_attachments(&store, "user", "thread", &mut parts, |_| unreachable_url())
        .await
        .unwrap();
    for meta in &parts[0].prompt.as_ref().unwrap().image_uploads {
        let path = tokio::fs::canonicalize(cached_path(&store, meta))
            .await
            .unwrap();
        assert_eq!(meta.local_path.as_deref(), path.to_str());
        assert_eq!(tokio::fs::read(path).await.unwrap(), b"data");
        let mut expected = meta.clone();
        expected.local_path = None;
        assert_eq!(
            store
                .attachment_metadata("user", "thread", file_id(meta))
                .await
                .unwrap(),
            Some(expected)
        );
    }
}

#[tokio::test]
async fn staged_attachments_skip_url_resolution_and_publish_local_files() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into());
    let mut attachments = Vec::new();
    for id in ["one", "two"] {
        let meta = attachment(id, 4);
        let staged = store.pending_attachment_path("user", file_id(&meta));
        tokio::fs::create_dir_all(staged.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(staged, b"data").await.unwrap();
        attachments.push(meta);
    }
    let mut parts = vec![prompt_part(7, attachments)];
    cache_prompt_attachments(&store, "user", "thread", &mut parts, |_| unreachable_url())
        .await
        .unwrap();
    for meta in &parts[0].prompt.as_ref().unwrap().image_uploads {
        let path = tokio::fs::canonicalize(cached_path(&store, meta))
            .await
            .unwrap();
        assert_eq!(meta.local_path.as_deref(), path.to_str());
        assert_eq!(tokio::fs::read(path).await.unwrap(), b"data");
        assert!(
            !store
                .pending_attachment_path("user", file_id(meta))
                .exists()
        );
    }
}

#[tokio::test]
async fn attachment_free_history_skips_url_resolution() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into());
    let mut non_prompt = prompt_part(8, Vec::new());
    non_prompt.kind = TranscriptPartKind::Completion;
    non_prompt.prompt = None;
    for mut parts in [Vec::new(), vec![prompt_part(7, Vec::new()), non_prompt]] {
        cache_prompt_attachments(&store, "user", "thread", &mut parts, |_| unreachable_url())
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn concurrent_caching_resolves_url_once_after_rechecking_local_files() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into());
    let (url, server) = serve(200, "data").await;
    let mut first = vec![prompt_part(7, vec![attachment("concurrent", 4)])];
    let mut second = first.clone();
    let calls = AtomicUsize::new(0);
    let resolve = |file_id: String| {
        assert_eq!(file_id, "file-concurrent");
        calls.fetch_add(1, Ordering::SeqCst);
        let url = url.clone();
        async move {
            tokio::task::yield_now().await;
            Ok(url)
        }
    };
    let (first_result, second_result) =
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(
                cache_prompt_attachments(&store, "user", "thread", &mut first, resolve),
                cache_prompt_attachments(&store, "user", "thread", &mut second, resolve)
            )
        })
        .await
        .unwrap();
    first_result.unwrap();
    second_result.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(first, second);
    let meta = &first[0].prompt.as_ref().unwrap().image_uploads[0];
    assert_eq!(
        tokio::fs::read(meta.local_path.as_ref().unwrap())
            .await
            .unwrap(),
        b"data"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn resolver_errors_propagate_without_publishing_files() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into());
    let meta = attachment("resolver-error", 4);
    let path = cached_path(&store, &meta);
    let mut parts = vec![prompt_part(7, vec![meta])];
    let error = cache_prompt_attachments(&store, "user", "thread", &mut parts, |_| async {
        anyhow::bail!("URL lookup failed")
    })
    .await
    .unwrap_err();
    assert_eq!(error.to_string(), "URL lookup failed");
    assert!(!path.exists());
}

#[tokio::test]
async fn resolved_download_errors_propagate_without_publishing_files() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into());
    let (url, server) = serve(503, "").await;
    let meta = attachment("download-error", 4);
    let path = cached_path(&store, &meta);
    let mut parts = vec![prompt_part(7, vec![meta])];
    let error = cache_prompt_attachments(&store, "user", "thread", &mut parts, |_| {
        let url = url.clone();
        async move { Ok(url) }
    })
    .await
    .unwrap_err();
    assert_eq!(
        error.downcast_ref::<reqwest::Error>().unwrap().status(),
        Some(reqwest::StatusCode::SERVICE_UNAVAILABLE)
    );
    assert!(!path.exists());
    server.await.unwrap();
}

#[tokio::test]
async fn expires_abandoned_staging_without_removing_fresh_or_submitted_files() {
    use std::time::{Duration, SystemTime};
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into());
    let now = SystemTime::now();
    let old = now - Duration::from_secs(2 * 24 * 60 * 60);
    let cutoff = now - Duration::from_secs(24 * 60 * 60);
    assert_eq!(store.prune_pending_attachments(cutoff).await.unwrap(), 0);

    let stale = store.pending_attachment_path("user", "stale");
    let fresh = store.pending_attachment_path("user", "fresh");
    let crashed = store.pending_attachment_path("other", "upload");
    let submitted = cached_path(&store, &attachment("submitted", 0));
    for path in [&stale, &fresh, &crashed, &submitted] {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let file = std::fs::File::create(path).unwrap();
        file.set_modified(if path == &fresh { now } else { old })
            .unwrap();
    }
    let guard = store.protect_pending_upload(&stale).await;
    assert_eq!(store.prune_pending_attachments(cutoff).await.unwrap(), 1);
    assert!(stale.exists());
    drop(guard);
    assert_eq!(store.prune_pending_attachments(cutoff).await.unwrap(), 1);
    assert!(!stale.exists());
    assert!(!crashed.exists());
    assert!(fresh.exists());
    assert!(submitted.exists());
    assert_eq!(store.prune_pending_attachments(cutoff).await.unwrap(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn pending_expiry_does_not_follow_directory_symlinks() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into());
    let target = outside.path().join("keep");
    std::fs::write(&target, b"keep").unwrap();
    let pending = store.pending_attachment_path("user", "ignored");
    std::fs::create_dir_all(pending.parent().unwrap().parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(outside.path(), pending.parent().unwrap()).unwrap();
    assert_eq!(
        store
            .prune_pending_attachments(std::time::SystemTime::now())
            .await
            .unwrap(),
        0
    );
    assert!(target.exists());
}

#[test]
fn cache_filenames_keep_extensions_when_long_unicode_names_are_shortened() {
    let store = TranscriptStore::new(PathBuf::from("/cache"));
    let mut meta = attachment("long", 0);
    meta.name = format!("{}.csv", "表".repeat(250));
    let path = cached_path(&store, &meta);
    assert_eq!(path.extension().unwrap(), "csv");
    assert!(path.file_name().unwrap().to_string_lossy().len() <= 205);
}

#[test]
fn attachment_paths_keep_untrusted_ids_and_names_inside_the_cache() {
    let root = std::env::temp_dir().join("attachment-path-test");
    let store = TranscriptStore::new(root.clone());
    for input in [
        "../../outside",
        r"..\..\outside",
        "/etc/passwd",
        r"C:\outside",
    ] {
        for path in [
            store.attachment_path(input, input, input, input),
            store.pending_attachment_path(input, input),
        ] {
            let relative = path.strip_prefix(&root).unwrap();
            assert!(
                relative
                    .components()
                    .all(|part| matches!(part, std::path::Component::Normal(_))),
                "{}",
                path.display()
            );
        }
    }
}

#[tokio::test]
async fn discarding_a_draft_removes_only_its_staging_and_thread_copy() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into());
    let meta = attachment("draft", 4);
    let staged = store.pending_attachment_path("user", file_id(&meta));
    tokio::fs::create_dir_all(staged.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&staged, b"data").await.unwrap();
    let path = cache_attachment(&store, "user", "thread", &meta, unreachable_url)
        .await
        .unwrap();
    let unrelated = store.pending_attachment_path("user", "other");
    tokio::fs::write(&unrelated, b"keep").await.unwrap();
    store
        .discard_attachment("user", Some("thread"), file_id(&meta))
        .await
        .unwrap();
    assert!(!path.exists());
    assert!(!staged.exists());
    assert!(unrelated.exists());
}

#[tokio::test]
async fn moves_staged_files_into_their_thread_without_size_or_count_caps() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into());
    let mut attachments = Vec::new();
    for id in 0..6 {
        let meta = attachment(&id.to_string(), 11 * 1024 * 1024);
        let staged = store.pending_attachment_path("user", file_id(&meta));
        tokio::fs::create_dir_all(staged.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::File::create(&staged)
            .await
            .unwrap()
            .set_len(meta.size)
            .await
            .unwrap();
        attachments.push(meta);
    }
    let mut parts = vec![TranscriptPart {
        number: 0,
        source_key: "prompt:0".into(),
        kind: TranscriptPartKind::Prompt,
        run_id: "run".into(),
        created_at: None,
        prompt: Some(TranscriptPromptBody {
            text: String::new(),
            image_uploads: attachments,
            hidden: None,
        }),
        completion: None,
        tool: None,
    }];
    cache_prompt_attachments(&store, "user", "thread", &mut parts, |_| unreachable_url())
        .await
        .unwrap();
    let prompt = parts[0].prompt.as_ref().unwrap();
    for meta in &prompt.image_uploads {
        let path = Path::new(meta.local_path.as_ref().unwrap());
        assert!(path.starts_with(store.thread_dir("user", "thread").join("attachments")));
        assert_eq!(tokio::fs::metadata(path).await.unwrap().len(), meta.size);
        assert!(
            !store
                .pending_attachment_path("user", file_id(meta))
                .exists()
        );
    }
    let text = prompt.text_with_attachments();
    assert_eq!(text.matches("local transcript cache").count(), 1);
    assert_eq!(text.matches("file-.._notes.txt").count(), 6);
}

#[tokio::test]
async fn writes_metadata_with_file_identity_only() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into());
    let meta = attachment("metadata", 4);
    let current = cached_path(&store, &meta);
    let staged = store.pending_attachment_path("user", file_id(&meta));
    tokio::fs::create_dir_all(staged.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&staged, b"data").await.unwrap();
    let path = cache_attachment(&store, "user", "thread", &meta, unreachable_url)
        .await
        .unwrap();
    assert_eq!(path, current);
    assert_eq!(tokio::fs::read(&path).await.unwrap(), b"data");
    let written: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(path.parent().unwrap().join("metadata.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(written["fileId"], file_id(&meta));
    assert!(written.get("localPath").is_none());
    assert_eq!(
        store
            .attachment_metadata("user", "thread", file_id(&meta))
            .await
            .unwrap(),
        Some(meta.clone())
    );
    store
        .discard_attachment("user", Some("thread"), file_id(&meta))
        .await
        .unwrap();
    assert!(!current.exists());
}

#[tokio::test]
async fn attachment_lookup_checks_identity_and_stays_in_its_thread() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into());
    let meta = attachment("one", 4);
    store
        .save_attachment_metadata("user", "thread", &meta)
        .await
        .unwrap();
    assert!(
        store
            .attachment_metadata("user", "other", file_id(&meta))
            .await
            .unwrap()
            .is_none()
    );
    store
        .append_parts(
            "user",
            "other",
            &[prompt_part(3, vec![]), prompt_part(105, vec![meta.clone()])],
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .attachment_metadata("user", "other", file_id(&meta))
            .await
            .unwrap(),
        Some(meta.clone())
    );
    let current = cached_path(&store, &meta);
    let mut wrong = meta.clone();
    wrong.file_id = Some("other-file".into());
    tokio::fs::write(
        current.parent().unwrap().join("metadata.json"),
        serde_json::to_vec(&wrong).unwrap(),
    )
    .await
    .unwrap();
    assert!(
        store
            .attachment_metadata("user", "thread", file_id(&meta))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn rejects_corrupt_staging_without_publishing_partial_files() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into());
    let meta = attachment("bad", 5);
    let staged = store.pending_attachment_path("user", file_id(&meta));
    tokio::fs::create_dir_all(staged.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&staged, b"data").await.unwrap();
    assert!(
        cache_attachment(&store, "user", "thread", &meta, unreachable_url)
            .await
            .is_err()
    );
    assert!(!cached_path(&store, &meta).exists());
    assert!(staged.exists());
}

#[tokio::test]
async fn deleted_files_skip_download_and_cached_files_remain_usable() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().into());
    let cached = attachment("cached", 4);
    let mut deleted = attachment("deleted", 4);
    deleted.file_id = None;
    let staged = store.pending_attachment_path("user", file_id(&cached));
    tokio::fs::create_dir_all(staged.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(staged, b"data").await.unwrap();
    let mut parts = vec![TranscriptPart {
        number: 0,
        source_key: "prompt:0".into(),
        kind: TranscriptPartKind::Prompt,
        run_id: "run".into(),
        created_at: None,
        prompt: Some(TranscriptPromptBody {
            text: "Continue".into(),
            image_uploads: vec![cached, deleted],
            hidden: None,
        }),
        completion: None,
        tool: None,
    }];
    cache_prompt_attachments(&store, "user", "thread", &mut parts, |_| unreachable_url())
        .await
        .unwrap();
    let prompt = parts[0].prompt.as_ref().unwrap();
    assert!(prompt.image_uploads[0].local_path.is_some());
    assert!(prompt.image_uploads[1].local_path.is_none());
    let text = prompt.text_with_attachments();
    let (user_text, metadata) = text
        .split_once("\n\nAttached files in the local transcript cache:\n")
        .unwrap();
    assert_eq!(user_text, "Continue");
    let metadata: serde_json::Value = serde_json::from_str(metadata).unwrap();
    assert_eq!(
        metadata[0]["path"],
        serde_json::json!(prompt.image_uploads[0].local_path)
    );
    assert_eq!(metadata[1]["path"], serde_json::Value::Null);
}
