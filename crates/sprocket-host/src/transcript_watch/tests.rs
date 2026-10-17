use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

impl TranscriptWatchers {
    fn active_count(&self) -> usize {
        self.registry.active_count()
    }
}

fn native_auth() -> Arc<NativeAuthManager> {
    NativeAuthManager::configured_for_test(
        crate::native_auth::NativeAuthConfig {
            workos_client_id: "client_test".to_string(),
        },
        "http://127.0.0.1/callback".to_string(),
    )
}

#[tokio::test]
async fn last_close_cancels_the_watch_task() {
    let dir = std::env::temp_dir().join(format!("sprocket-watch-{}", uuid::Uuid::new_v4()));
    let store = TranscriptStore::new(dir.clone());
    let live = Arc::new(AtomicUsize::new(0));
    let live_task = live.clone();
    let watchers = TranscriptWatchers::with_starter(
        "https://example.convex.cloud".into(),
        store,
        native_auth(),
        Arc::new(move |_start| {
            let live_task = live_task.clone();
            live_task.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                struct DropLive(Arc<AtomicUsize>);
                impl Drop for DropLive {
                    fn drop(&mut self) {
                        self.0.fetch_sub(1, Ordering::SeqCst);
                    }
                }
                let _live = DropLive(live_task);
                std::future::pending::<()>().await;
            })
        }),
    );

    let first = watchers.open("user", "thread").await;
    let second = watchers.open("user", "thread").await;
    assert_eq!(watchers.active_count(), 1);
    assert_eq!(live.load(Ordering::SeqCst), 1);
    drop(first);
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert_eq!(watchers.active_count(), 1);
    drop(second);
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    assert_eq!(watchers.active_count(), 0);
    assert_eq!(live.load(Ordering::SeqCst), 0);
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn local_updates_are_sent_to_open_sessions() {
    let dir = std::env::temp_dir().join(format!("sprocket-watch-{}", uuid::Uuid::new_v4()));
    let store = TranscriptStore::new(dir.clone());
    let watchers = TranscriptWatchers::with_starter(
        "https://example.convex.cloud".into(),
        store,
        native_auth(),
        Arc::new(|_start| tokio::spawn(std::future::pending())),
    );
    let mut session = watchers.open("user", "thread").await;

    watchers
        .notify_local_update("user", "thread", 4, true)
        .await;

    let event = session.receiver().recv().await.expect("local update");
    assert_eq!(event.total_parts, Some(4));
    assert!(event.stale);
    drop(session);
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn closing_an_aborted_session_does_not_cancel_its_replacement() {
    let dir = std::env::temp_dir().join(format!("sprocket-watch-{}", uuid::Uuid::new_v4()));
    let watchers = TranscriptWatchers::with_starter(
        "https://example.convex.cloud".into(),
        TranscriptStore::new(dir.clone()),
        native_auth(),
        Arc::new(|_start| tokio::spawn(std::future::pending())),
    );
    let old = watchers.open("user", "thread").await;
    watchers.abort_thread("user", "thread").await;
    let mut replacement = watchers.open("user", "thread").await;
    drop(old);
    assert_eq!(watchers.active_count(), 1);
    watchers
        .notify_local_update("user", "thread", 7, false)
        .await;
    assert_eq!(
        replacement.receiver().recv().await.unwrap().total_parts,
        Some(7)
    );
    drop(replacement);
    assert_eq!(watchers.active_count(), 0);
    let _ = tokio::fs::remove_dir_all(dir).await;
}
