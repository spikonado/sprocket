use super::*;

#[tokio::test]
async fn stale_session_does_not_close_its_replacement() {
    let registry: Arc<WatchRegistry<String, u32>> = WatchRegistry::new();
    let spawn = |events: broadcast::Sender<u32>, ()| {
        let _ = events;
        tokio::spawn(std::future::pending())
    };
    let (old, ()) = registry.open_with("key".to_string(), 4, || (), spawn);
    registry.abort(&"key".to_string());
    let (mut replacement, ()) = registry.open_with(
        "key".to_string(),
        4,
        || (),
        |events, ()| {
            let _ = events;
            tokio::spawn(std::future::pending())
        },
    );
    drop(old);
    assert_eq!(registry.active_count(), 1);
    registry.send_to(&"key".to_string(), 7);
    assert_eq!(replacement.receiver().recv().await.unwrap(), 7);
    drop(replacement);
    assert_eq!(registry.active_count(), 0);
}

#[tokio::test]
async fn first_open_receiver_sees_events_sent_during_spawn() {
    let registry: Arc<WatchRegistry<String, u32>> = WatchRegistry::new();
    let (mut session, ()) = registry.open_with(
        "key".to_string(),
        4,
        || (),
        |events, ()| {
            let _ = events.send(1);
            tokio::spawn(std::future::pending())
        },
    );
    assert_eq!(session.receiver().try_recv().unwrap(), 1);
}

#[tokio::test]
async fn last_drop_aborts_the_task() {
    let registry: Arc<WatchRegistry<String, u32>> = WatchRegistry::new();
    let (task_alive_tx, mut task_alive_rx) = tokio::sync::oneshot::channel::<()>();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let spawn = move |events: broadcast::Sender<u32>, ()| {
        let _ = events;
        tokio::spawn(async move {
            let _task_alive = task_alive_tx;
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        })
    };
    let (first, ()) = registry.open_with("key".to_string(), 4, || (), spawn);
    let (second, ()) = registry.open_with(
        "key".to_string(),
        4,
        || (),
        |_, ()| panic!("existing slot should not spawn"),
    );
    started_rx.await.expect("watch task started");
    drop(first);
    assert_eq!(registry.active_count(), 1);
    assert!(matches!(
        task_alive_rx.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    drop(second);
    assert_eq!(registry.active_count(), 0);
    tokio::time::timeout(std::time::Duration::from_secs(1), task_alive_rx)
        .await
        .expect("watch task dropped after last session")
        .expect_err("watch task released its sender");
}
