use super::*;
use tokio::sync::mpsc;

impl TranscriptWatchers {
    fn active_count(&self) -> usize {
        self.registry.active_count()
    }
}

fn convex() -> Arc<ConvexClients> {
    ConvexClients::new(
        "https://example.convex.cloud".into(),
        crate::native_auth::NativeAuthManager::configured_for_test(
            crate::native_auth::NativeAuthConfig {
                workos_client_id: "client_test".to_string(),
            },
            "http://127.0.0.1/callback".to_string(),
        ),
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LifecycleEvent {
    TaskStarted,
    RemoteSubscribed,
    RemoteDropped,
    LocalStarted,
    TaskDropped,
}

struct OnDrop(mpsc::UnboundedSender<LifecycleEvent>, LifecycleEvent);

impl Drop for OnDrop {
    fn drop(&mut self) {
        let _ = self.0.send(self.1);
    }
}

fn fake_watchers(
    store: Arc<TranscriptStore>,
) -> (
    Arc<TranscriptWatchers>,
    mpsc::UnboundedReceiver<LifecycleEvent>,
) {
    let (events, receiver) = mpsc::unbounded_channel();
    let watchers = TranscriptWatchers::with_starter(
        convex(),
        store,
        Arc::new(move |start| {
            let events = events.clone();
            events.send(LifecycleEvent::TaskStarted).unwrap();
            let task = OnDrop(events.clone(), LifecycleEvent::TaskDropped);
            tokio::spawn(async move {
                let _task = task;
                crate::work_sync::follow_modes(start.modes, |mode| {
                    let events = events.clone();
                    async move {
                        let _subscription = match mode {
                            SyncMode::Remote => {
                                events.send(LifecycleEvent::RemoteSubscribed).unwrap();
                                Some(OnDrop(events, LifecycleEvent::RemoteDropped))
                            }
                            SyncMode::Local(start) => {
                                start.total.set(Some(0)).unwrap();
                                events.send(LifecycleEvent::LocalStarted).unwrap();
                                None
                            }
                        };
                        std::future::pending::<anyhow::Result<()>>().await
                    }
                })
                .await
                .unwrap();
            })
        }),
    );
    (watchers, receiver)
}

async fn expect_event(
    events: &mut mpsc::UnboundedReceiver<LifecycleEvent>,
    expected: LifecycleEvent,
) {
    let actual = tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .unwrap();
    assert_eq!(actual, Some(expected));
}

#[tokio::test]
async fn cloud_status_changes_notify_existing_sessions_without_part_writes() {
    let dir = tempfile::tempdir().unwrap();
    let (watchers, _events) = fake_watchers(TranscriptStore::new(dir.path().to_owned()));
    let tab = watchers.open("user", "thread").await;
    let start = WatchStart {
        convex: Arc::clone(&watchers.convex),
        store: Arc::clone(&watchers.store),
        user_id: "user".into(),
        thread_id: "thread".into(),
        events: broadcast::channel(8).0,
        modes: tab.state.modes.subscribe(),
        status: tab.state.status.clone(),
    };
    let mut events = start.events.subscribe();
    let changes = start.store.watch_changes();
    let forwarding = tokio::spawn(async move { forward_changes(&start, changes).await });
    tokio::task::yield_now().await;
    assert!(!tab.stale());
    for status in [
        TranscriptSyncStatus::Ready,
        TranscriptSyncStatus::Unavailable,
        TranscriptSyncStatus::Ready,
    ] {
        tab.state.status.send_replace(status);
        tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(tab.stale(), status == TranscriptSyncStatus::Unavailable);
    }
    forwarding.abort();
    assert!(forwarding.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn new_run_starts_local_and_keeps_the_task_after_tabs_close() {
    let dir = tempfile::tempdir().unwrap();
    let (watchers, mut events) = fake_watchers(TranscriptStore::new(dir.path().to_owned()));
    let run = tokio::time::timeout(Duration::from_secs(5), watchers.open_run("user", "thread"))
        .await
        .unwrap();
    expect_event(&mut events, LifecycleEvent::TaskStarted).await;
    expect_event(&mut events, LifecycleEvent::LocalStarted).await;

    let first_tab = watchers.open("user", "thread").await;
    let second_tab = watchers.open("user", "thread").await;
    assert_eq!(watchers.active_count(), 1);
    drop(first_tab);
    assert_eq!(watchers.active_count(), 1);
    drop(second_tab);
    assert_eq!(watchers.active_count(), 1);
    assert!(events.try_recv().is_err());

    drop(run);
    assert_eq!(watchers.active_count(), 0);
    expect_event(&mut events, LifecycleEvent::TaskDropped).await;
}

#[tokio::test]
async fn runs_pause_the_shared_subscription_until_the_last_run_closes() {
    let dir = tempfile::tempdir().unwrap();
    let (watchers, mut events) = fake_watchers(TranscriptStore::new(dir.path().to_owned()));
    let tab = watchers.open("user", "thread").await;
    expect_event(&mut events, LifecycleEvent::TaskStarted).await;
    expect_event(&mut events, LifecycleEvent::RemoteSubscribed).await;

    let first_run =
        tokio::time::timeout(Duration::from_secs(5), watchers.open_run("user", "thread"))
            .await
            .unwrap();
    assert_eq!(events.try_recv().unwrap(), LifecycleEvent::RemoteDropped);
    expect_event(&mut events, LifecycleEvent::LocalStarted).await;
    let second_run =
        tokio::time::timeout(Duration::from_secs(5), watchers.open_run("user", "thread"))
            .await
            .unwrap();
    assert!(Arc::ptr_eq(&first_run.start, &second_run.start));
    assert_eq!(watchers.active_count(), 1);

    drop(first_run);
    assert!(matches!(
        &*second_run.state.modes.borrow(),
        SyncMode::Local(_)
    ));
    assert!(events.try_recv().is_err());
    drop(second_run);
    expect_event(&mut events, LifecycleEvent::RemoteSubscribed).await;
    assert_eq!(watchers.active_count(), 1);

    let next_run =
        tokio::time::timeout(Duration::from_secs(5), watchers.open_run("user", "thread"))
            .await
            .unwrap();
    expect_event(&mut events, LifecycleEvent::RemoteDropped).await;
    expect_event(&mut events, LifecycleEvent::LocalStarted).await;
    assert_eq!(watchers.active_count(), 1);
    drop(next_run);
    expect_event(&mut events, LifecycleEvent::RemoteSubscribed).await;

    drop(tab);
    assert_eq!(watchers.active_count(), 0);
    expect_event(&mut events, LifecycleEvent::RemoteDropped).await;
    expect_event(&mut events, LifecycleEvent::TaskDropped).await;
}
