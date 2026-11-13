use super::*;

impl RunRecovery {
    async fn saved(&self, user_id: &str, submission_id: &str) -> Option<RecoveryRecord> {
        self.records
            .lock()
            .await
            .get(&format!("{user_id}:{submission_id}"))
            .cloned()
    }
}

fn record() -> RecoveryRecord {
    RecoveryRecord::new(
        serde_json::from_value(serde_json::json!({
            "userId": "alice", "submissionId": "submission", "threadId": "thread",
            "prompt": "build it", "storageIds": ["image"], "selectedModel": "model",
            "reasoningEffort": "high", "fastMode": true, "workspacePath": "/work",
            "executionSecret": "secret"
        }))
        .unwrap(),
        WorkspaceAccess::Attached,
        true,
    )
}

#[tokio::test]
async fn reload_preserves_capability_and_budget_but_releases_live_reservations() {
    let directory = tempfile::tempdir().unwrap();
    let store = RunRecovery::load(directory.path()).unwrap();
    let mut next = record();
    next.request.service_tier = Some(sprocket_agent::ServiceTier::Ultrafast);
    next.request.fast_mode = false;
    let next = next.continuation("failed".into(), "thread".into()).unwrap();
    let (_guard, _) = store.begin(next.clone(), RunOwner::Host).await.unwrap();
    assert!(store.reserve_exclusive(next.key()).is_none());
    let reloaded = RunRecovery::load(directory.path()).unwrap();
    let saved = reloaded
        .saved("alice", &next.request.submission_id)
        .await
        .unwrap();
    assert_eq!(saved.recoveries, 1);
    assert_eq!(
        saved.request.execution_secret,
        next.request.execution_secret
    );
    assert_eq!(
        saved.request.continuation_of_run_id.as_deref(),
        Some("failed")
    );
    assert!(saved.request.prompt.is_empty());
    assert!(saved.request.storage_ids.is_empty());
    assert_eq!(saved.request.workspace_path, "/work");
    assert_eq!(saved.request.reasoning_effort, "high");
    assert_eq!(
        saved.request.service_tier,
        Some(sprocket_agent::ServiceTier::Ultrafast)
    );
    assert!(!saved.request.fast_mode);
    assert!(reloaded.reserve_exclusive(next.key()).is_some());
}

#[tokio::test]
async fn overlapping_submissions_launch_with_the_persisted_capability() {
    for supplied_secrets in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let store = RunRecovery::load(directory.path()).unwrap();
        let mut first = record()
            .continuation("failed".into(), "thread".into())
            .unwrap();
        first.request.execution_secret = supplied_secrets.then(|| "first".into());
        let mut second = first.clone();
        second.request.execution_secret = supplied_secrets.then(|| "second".into());
        second.recoveries = 0;
        let (first_launch, second_launch) = tokio::join!(
            store.begin(first.clone(), RunOwner::Host),
            store.begin(second, RunOwner::Host)
        );
        let (first_guard, first_saved) = first_launch.unwrap();
        let (second_guard, second_saved) = second_launch.unwrap();
        let persisted = RunRecovery::load(directory.path())
            .unwrap()
            .saved("alice", &first.request.submission_id)
            .await
            .unwrap();
        assert!(persisted.request.execution_secret.is_some());
        assert_eq!(
            first_saved.request.execution_secret,
            persisted.request.execution_secret
        );
        assert_eq!(
            second_saved.request.execution_secret,
            persisted.request.execution_secret
        );
        assert_eq!(first_saved.recoveries, persisted.recoveries);
        assert_eq!(second_saved.recoveries, persisted.recoveries);
        assert!(store.reserve_exclusive(first.key()).is_none());
        drop(first_guard);
        assert!(store.reserve_exclusive(first.key()).is_none());
        drop(second_guard);
        assert!(store.reserve_exclusive(first.key()).is_some());
    }
}

#[tokio::test]
async fn client_owned_runs_never_enter_the_recovery_journal() {
    let directory = tempfile::tempdir().unwrap();
    let store = RunRecovery::load(directory.path()).unwrap();
    let mut candidate = record();
    candidate.workspace_access = WorkspaceAccess::RunDirectory;
    candidate.allow_interaction = false;
    candidate.request.execution_secret = None;
    let (guard, prepared) = store
        .begin(candidate.clone(), RunOwner::Client)
        .await
        .unwrap();
    assert!(guard.is_none());
    assert!(prepared.request.execution_secret.is_some());
    assert!(store.records.lock().await.is_empty());
    assert!(store.active.lock().unwrap().is_empty());
    assert!(!directory.path().join("run-recovery.json").exists());
    assert!(
        RunRecovery::load(directory.path())
            .unwrap()
            .records
            .lock()
            .await
            .is_empty()
    );
    candidate.allow_interaction = true;
    let (guard, _) = store.begin(candidate, RunOwner::Host).await.unwrap();
    assert!(guard.is_some());
    assert_eq!(store.records.lock().await.len(), 1);
}

#[tokio::test]
async fn dropping_a_caller_does_not_interrupt_the_disk_and_memory_commit() {
    let directory = tempfile::tempdir().unwrap();
    let store = RunRecovery::load(directory.path()).unwrap();
    let held = store.records.lock().await;
    let writer = tokio::spawn({
        let store = Arc::clone(&store);
        async move { store.begin(record(), RunOwner::Host).await }
    });
    while !store.active.lock().unwrap().contains_key(&record().key()) {
        tokio::task::yield_now().await;
    }
    writer.abort();
    let _ = writer.await;
    drop(held);
    timeout(Duration::from_secs(5), async {
        while store.saved("alice", "submission").await.is_none() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the detached insert commits");
    assert!(
        RunRecovery::load(directory.path())
            .unwrap()
            .saved("alice", "submission")
            .await
            .is_some()
    );
    assert!(!store.active.lock().unwrap().contains_key(&record().key()));
}

#[tokio::test]
async fn replacement_is_durable_and_recovery_is_bounded() {
    let directory = tempfile::tempdir().unwrap();
    let store = RunRecovery::load(directory.path()).unwrap();
    let original = record();
    drop(store.begin(original.clone(), RunOwner::Host).await.unwrap());
    let mut next = original.clone();
    for _ in 0..MAX_RECOVERIES {
        next = next.continuation("failed".into(), "thread".into()).unwrap();
    }
    assert!(
        next.continuation("failed".into(), "thread".into())
            .is_none()
    );
    store
        .replace(&original.key(), Some(next.clone()))
        .await
        .unwrap();
    let reloaded = RunRecovery::load(directory.path()).unwrap();
    assert!(reloaded.saved("alice", "submission").await.is_none());
    assert!(
        reloaded
            .saved("alice", &next.request.submission_id)
            .await
            .is_some()
    );
    reloaded.replace(&next.key(), None).await.unwrap();
    assert!(
        RunRecovery::load(directory.path())
            .unwrap()
            .records
            .lock()
            .await
            .is_empty()
    );
}

#[test]
fn missing_relaunches_back_off_to_thirty_minutes() {
    let retries = MissingRetries::default();
    let mut round = 0;
    let mut gaps = Vec::new();
    for _ in 0..8 {
        retries.launched("key", round);
        let next = (round..).find(|&next| retries.due("key", next)).unwrap();
        gaps.push(next - round);
        round = next;
    }
    assert_eq!(gaps, [1, 2, 4, 8, 16, 32, 60, 60]);
    retries.clear("key");
    assert!(retries.due("key", round));
}
