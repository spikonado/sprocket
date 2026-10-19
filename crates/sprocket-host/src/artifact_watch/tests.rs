use super::*;
use sprocket_workspace::artifact_bindings::ArtifactBinding;
use std::sync::atomic::{AtomicUsize, Ordering};

impl ArtifactWatchers {
    fn active_count(&self) -> usize {
        self.registry.active_count()
    }

    fn task_abort_handle(&self, key: &WatchKey) -> Option<tokio::task::AbortHandle> {
        self.registry.task_abort_handle(key)
    }
}

#[tokio::test(start_paused = true)]
async fn cloud_subscription_does_not_poll_or_reload_already_loaded_revisions() {
    let (updates, subscription) = futures::channel::mpsc::unbounded();
    let (_pending, pending) = tokio::sync::watch::channel(Vec::new());
    let (output, mut snapshots) = tokio::sync::mpsc::channel(1);
    let loads = Arc::new(AtomicUsize::new(0));
    let task_loads = Arc::clone(&loads);
    let task = tokio::spawn(async move {
        cloud_session(
            subscription,
            &pending,
            &output,
            || {
                let revision = task_loads.fetch_add(1, Ordering::SeqCst) as u64 + 2;
                std::future::ready(Ok(ArtifactSnapshot {
                    artifacts: vec![],
                    revision,
                }))
            },
            |_| async { panic!("idle watcher must not sync") },
        )
        .await
    });
    updates.unbounded_send(Ok(1)).unwrap();
    assert_eq!(snapshots.recv().await.unwrap().unwrap().revision, 2);
    updates.unbounded_send(Ok(1)).unwrap();
    updates.unbounded_send(Ok(2)).unwrap();
    tokio::time::advance(Duration::from_secs(60)).await;
    tokio::task::yield_now().await;
    assert_eq!(loads.load(Ordering::SeqCst), 1);
    assert!(snapshots.try_recv().is_err());

    updates.unbounded_send(Ok(3)).unwrap();
    assert_eq!(snapshots.recv().await.unwrap().unwrap().revision, 3);
    assert_eq!(loads.load(Ordering::SeqCst), 2);
    drop(snapshots);
    task.await.unwrap().unwrap();
}

#[tokio::test(start_paused = true)]
async fn local_changes_sync_without_a_cloud_revision_event() {
    let (updates, subscription) = futures::channel::mpsc::unbounded();
    let (pending_tx, pending) = tokio::sync::watch::channel(Vec::new());
    let (output, mut snapshots) = tokio::sync::mpsc::channel(1);
    let syncs = Arc::new(AtomicUsize::new(0));
    let task_syncs = Arc::clone(&syncs);
    let task = tokio::spawn(async move {
        cloud_session(
            subscription,
            &pending,
            &output,
            || async {
                Ok(ArtifactSnapshot {
                    artifacts: vec![],
                    revision: 1,
                })
            },
            |request| {
                assert_eq!(request.content, "local edit");
                task_syncs.fetch_add(1, Ordering::SeqCst);
                std::future::ready(Ok(()))
            },
        )
        .await
    });
    updates.unbounded_send(Ok(1)).unwrap();
    snapshots.recv().await.unwrap().unwrap();
    pending_tx.send_replace(vec![SyncRequest {
        artifact: remote(),
        path: "notes.md".into(),
        baseline: content_hash("initial"),
        content: "local edit".into(),
    }]);
    tokio::time::advance(Duration::from_secs(1)).await;
    snapshots.recv().await.unwrap().unwrap();
    assert_eq!(syncs.load(Ordering::SeqCst), 1);
    drop(snapshots);
    task.await.unwrap().unwrap();
}

#[tokio::test(start_paused = true)]
async fn cloud_subscription_failures_exit_for_reconnect() {
    for updates in [
        vec![],
        vec![Err(anyhow::anyhow!("Denied"))],
        vec![Ok(1), Err(anyhow::anyhow!("Disconnected"))],
    ] {
        let (_pending_tx, pending) = tokio::sync::watch::channel(Vec::new());
        let (output, _snapshots) = tokio::sync::mpsc::channel(1);
        let result = cloud_session(
            stream::iter(updates),
            &pending,
            &output,
            || async {
                Ok(ArtifactSnapshot {
                    artifacts: vec![],
                    revision: 1,
                })
            },
            |_| async { Ok(()) },
        )
        .await;
        assert!(result.is_err());
    }
    let (_pending_tx, pending) = tokio::sync::watch::channel(Vec::new());
    let (output, _snapshots) = tokio::sync::mpsc::channel(1);
    let result = cloud_session(
        stream::pending(),
        &pending,
        &output,
        || async { panic!("must receive the first revision before loading") },
        |_| async { Ok(()) },
    )
    .await;
    assert!(result.unwrap_err().is::<tokio::time::error::Elapsed>());
}

#[tokio::test]
async fn last_consumer_releases_shared_watch() {
    let dir = tempfile::tempdir().unwrap();
    let auth = NativeAuthManager::configured_for_test(
        crate::native_auth::NativeAuthConfig {
            workos_client_id: "client_test".into(),
        },
        "http://127.0.0.1/callback".into(),
    );
    let watchers = ArtifactWatchers::new(
        "https://example.convex.cloud".into(),
        auth,
        dir.path().into(),
    );
    let first = watchers.open("alice", "repo", "/workspace").await;
    let second = watchers.open("alice", "repo", "/workspace").await;
    let other = watchers.open("bob", "repo", "/workspace").await;
    let task = watchers.task_abort_handle(&first.key).expect("watch task");
    assert_eq!(watchers.active_count(), 2);
    drop(first);
    assert_eq!(watchers.active_count(), 2);
    drop(second);
    assert_eq!(watchers.active_count(), 1);
    drop(other);
    assert_eq!(watchers.active_count(), 0);
    tokio::task::yield_now().await;
    assert!(task.is_finished());
}

#[test]
fn duplicate_snapshots_do_not_fill_the_event_channel() {
    let (events, mut rx) = broadcast::channel(1);
    let latest = Mutex::new(None);
    let event = ArtifactWatchEvent {
        artifacts: vec![],
        stale: false,
        error: None,
    };
    publish(&events, &latest, event.clone());
    publish(&events, &latest, event);
    assert!(rx.try_recv().is_ok());
    assert!(matches!(
        rx.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
}

fn remote() -> RemoteArtifact {
    RemoteArtifact {
        id: "artifact".into(),
        user_id: "alice".into(),
        repository_key: "repo".into(),
        content: "initial".into(),
        content_type: ArtifactContentType::Markdown,
        title: "Notes".into(),
        revision: 1,
        updated_at: 1,
    }
}

async fn setup() -> (tempfile::TempDir, ArtifactFeed) {
    let dir = tempfile::tempdir().unwrap();
    let key = WatchKey {
        user_id: "alice".into(),
        repository_key: "repo".into(),
        workspace_path: dir.path().to_str().unwrap().into(),
    };
    let bindings =
        ArtifactBindings::new(&dir.path().join("data"), "deployment", "alice", dir.path());
    let mut feed = ArtifactFeed::new(key, bindings);
    feed.apply_registry(vec![remote()]);
    (dir, feed)
}

async fn bind(feed: &ArtifactFeed) {
    let mut guard = feed.bindings.lock().await.unwrap();
    guard
        .bind(ArtifactBinding {
            registration_id: "registration".into(),
            artifact_id: Some("artifact".into()),
            local_path: "notes.md".into(),
            content_hash: content_hash("initial"),
        })
        .unwrap();
    guard.persist().await.unwrap();
}

#[tokio::test]
async fn cloud_deletion_preserves_local_bindings_and_files() {
    let (dir, mut feed) = setup().await;
    std::fs::write(dir.path().join("notes.md"), "initial").unwrap();
    bind(&feed).await;
    feed.refresh().await.unwrap();
    feed.apply_registry(vec![]);
    feed.refresh().await.unwrap();

    assert!(feed.local.is_empty());
    assert!(feed.pending.is_empty());
    assert!(
        feed.bindings
            .lock()
            .await
            .unwrap()
            .get("artifact")
            .is_some()
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("notes.md")).unwrap(),
        "initial"
    );
}

#[tokio::test]
async fn unbound_artifacts_use_cloud_without_creating_files() {
    let (dir, mut feed) = setup().await;
    feed.refresh().await.unwrap();
    let view = &feed.local["artifact"];
    assert_eq!(view.remote.content, "initial");
    assert_eq!(view.local_path, None);
    assert!(feed.pending.is_empty());
    assert!(!dir.path().join("notes.md").exists());
}

#[tokio::test]
async fn colliding_legacy_bindings_keep_cloud_content_and_pause_sync() {
    let (dir, mut feed) = setup().await;
    bind(&feed).await;
    tokio::fs::write(dir.path().join("notes.md"), "local edit")
        .await
        .unwrap();
    let mut guard = feed.bindings.lock().await.unwrap();
    let mut second_binding = guard.get("artifact").unwrap().clone();
    second_binding.registration_id = "second-registration".into();
    second_binding.artifact_id = Some("second".into());
    second_binding.local_path = "./notes.md".into();
    guard.bindings.push(second_binding);
    guard.persist().await.unwrap();
    drop(guard);
    feed.apply_registry(vec![
        remote(),
        RemoteArtifact {
            id: "second".into(),
            content: "second content".into(),
            ..remote()
        },
    ]);
    feed.refresh().await.unwrap();
    assert!(feed.pending.is_empty());
    assert_eq!(feed.local["artifact"].remote.content, "initial");
    assert_eq!(feed.local["second"].remote.content, "second content");
    assert!(
        feed.local
            .values()
            .all(|artifact| artifact.local_error.is_some())
    );
    assert_eq!(
        tokio::fs::read_to_string(dir.path().join("notes.md"))
            .await
            .unwrap(),
        "local edit"
    );
}

#[tokio::test]
async fn baseline_survives_restart_and_detects_conflicts() {
    let (dir, mut feed) = setup().await;
    bind(&feed).await;
    tokio::fs::write(dir.path().join("notes.md"), "initial")
        .await
        .unwrap();
    let mut newer = remote();
    newer.content = "cloud edit".into();
    newer.revision = 2;
    feed.apply_registry(vec![newer]);
    feed.refresh().await.unwrap();
    assert_eq!(feed.local["artifact"].remote.content, "cloud edit");
    assert!(feed.pending.is_empty());
    tokio::fs::write(dir.path().join("notes.md"), "local edit")
        .await
        .unwrap();
    feed.refresh().await.unwrap();
    assert_eq!(feed.local["artifact"].remote.content, "local edit");
    assert!(
        feed.local["artifact"]
            .local_error
            .as_ref()
            .unwrap()
            .contains("Both")
    );
    assert!(feed.pending.is_empty());
}

#[tokio::test]
async fn local_edits_sync_but_missing_files_are_not_recreated() {
    let (dir, mut feed) = setup().await;
    bind(&feed).await;
    let path = dir.path().join("notes.md");
    tokio::fs::write(&path, "local edit").await.unwrap();
    feed.refresh().await.unwrap();
    assert_eq!(feed.pending.len(), 1);
    assert_eq!(feed.pending[0].artifact.revision, 1);
    tokio::fs::remove_file(&path).await.unwrap();
    feed.refresh().await.unwrap();
    assert!(feed.pending.is_empty());
    assert_eq!(feed.local["artifact"].remote.content, "local edit");
    assert!(feed.local["artifact"].local_error.is_some());
    assert!(!path.exists());
}

#[tokio::test]
async fn interrupted_sync_ack_reconciles_baseline() {
    let (dir, mut feed) = setup().await;
    bind(&feed).await;
    tokio::fs::write(dir.path().join("notes.md"), "synced")
        .await
        .unwrap();
    let mut synced = remote();
    synced.content = "synced".into();
    feed.apply_registry(vec![synced]);
    feed.refresh().await.unwrap();
    assert_eq!(
        feed.bindings
            .lock()
            .await
            .unwrap()
            .get("artifact")
            .unwrap()
            .content_hash,
        content_hash("synced")
    );
    tokio::fs::write(dir.path().join("notes.md"), "next")
        .await
        .unwrap();
    feed.refresh().await.unwrap();
    assert_eq!(feed.pending.len(), 1);
}

#[tokio::test]
async fn previews_continue_while_a_sync_holds_the_binding_lock() {
    let (dir, mut feed) = setup().await;
    bind(&feed).await;
    let _in_flight = feed.bindings.lock().await.unwrap();
    for content in ["first edit", "second edit"] {
        tokio::fs::write(dir.path().join("notes.md"), content)
            .await
            .unwrap();
        timeout(Duration::from_millis(500), feed.refresh())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(feed.local["artifact"].remote.content, content);
        assert_eq!(feed.pending[0].content, content);
    }
}

#[tokio::test]
async fn flush_saves_readable_files_before_reporting_missing_ones() {
    let (dir, mut feed) = setup().await;
    bind(&feed).await;
    tokio::fs::write(dir.path().join("notes.md"), "final edit")
        .await
        .unwrap();
    let missing = RemoteArtifact {
        id: "missing".into(),
        ..remote()
    };
    let mut guard = feed.bindings.lock().await.unwrap();
    guard
        .bind(ArtifactBinding {
            registration_id: "missing".into(),
            artifact_id: Some("missing".into()),
            local_path: "missing.md".into(),
            content_hash: content_hash("initial"),
        })
        .unwrap();
    guard.persist().await.unwrap();
    drop(guard);
    let registry = Mutex::new(vec![remote(), missing]);
    let result = flush_feed(
        &mut feed,
        || std::future::ready(Ok(registry.lock().unwrap().clone())),
        |request| {
            let mut registry = registry.lock().unwrap();
            registry[0].content = request.content;
            registry[0].revision += 1;
            std::future::ready(Ok(()))
        },
    )
    .await;
    assert!(result.is_err());
    assert_eq!(registry.lock().unwrap()[0].content, "final edit");
    assert!(!dir.path().join("missing.md").exists());
}

#[tokio::test]
async fn flush_reloads_if_another_watcher_advanced_the_baseline() {
    let (dir, mut feed) = setup().await;
    bind(&feed).await;
    tokio::fs::write(dir.path().join("notes.md"), "synced")
        .await
        .unwrap();
    let mut guard = feed.bindings.lock().await.unwrap();
    let mut binding = guard.get("artifact").unwrap().clone();
    binding.content_hash = content_hash("synced");
    guard.bind(binding).unwrap();
    guard.persist().await.unwrap();
    drop(guard);
    let mut loads = 0;
    flush_feed(
        &mut feed,
        || {
            loads += 1;
            let artifact = if loads == 1 {
                remote()
            } else {
                RemoteArtifact {
                    content: "synced".into(),
                    revision: 2,
                    ..remote()
                }
            };
            std::future::ready(Ok(vec![artifact]))
        },
        |_| {
            std::future::ready(Err(anyhow::anyhow!(
                "Already synced; no write should be needed"
            )))
        },
    )
    .await
    .unwrap();
    assert!(loads >= 2);
}

#[tokio::test]
async fn registry_filters_account_and_repository() {
    let (_dir, mut feed) = setup().await;
    for artifact in [
        RemoteArtifact {
            user_id: "bob".into(),
            ..remote()
        },
        RemoteArtifact {
            repository_key: "other".into(),
            ..remote()
        },
    ] {
        feed.apply_registry(vec![artifact]);
        feed.refresh().await.unwrap();
        assert!(feed.local.is_empty());
    }
}
