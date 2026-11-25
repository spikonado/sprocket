use std::time::Duration;

use super::*;

fn age_marker(store: &TranscriptStore, thread: &str, age: Duration) {
    File::options()
        .append(true)
        .open(store.thread_dir("user", thread).join(LAST_OPENED_FILE))
        .unwrap()
        .set_modified(SystemTime::now() - age)
        .unwrap();
}

#[tokio::test]
async fn removes_idle_threads_last_opened_before_the_cutoff() {
    let root = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(root.path().to_owned());
    let month = Duration::from_secs(30 * 24 * 60 * 60);
    for thread in ["stale", "recent", "open"] {
        drop(store.open_thread("user", thread).await.unwrap());
    }
    let _open = store.open_thread("user", "open").await.unwrap();
    age_marker(&store, "stale", month * 2);
    age_marker(&store, "open", month * 2);
    let legacy = store.thread_dir("user", "legacy");
    fs::create_dir_all(&legacy).unwrap();
    let pending = store.pending_attachment_path("user", "upload");
    fs::create_dir_all(pending.parent().unwrap()).unwrap();
    fs::write(&pending, b"bytes").unwrap();

    store
        .remove_threads_opened_before(SystemTime::now() - month)
        .await
        .unwrap();

    assert!(!store.thread_dir("user", "stale").exists());
    assert!(store.thread_dir("user", "recent").exists());
    assert!(store.thread_dir("user", "open").exists());
    assert!(legacy.join(LAST_OPENED_FILE).exists());
    assert!(pending.exists());
}
