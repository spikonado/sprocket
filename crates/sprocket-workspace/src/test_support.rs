use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEMP_WORKSPACE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) fn temp_workspace() -> PathBuf {
    temp_workspace_labeled("sprocket-workspace-tests")
}

pub(crate) fn temp_workspace_labeled(label: &str) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let counter = TEMP_WORKSPACE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "{label}-{timestamp}-{}-{counter}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("temp dir should be created");
    path.canonicalize().expect("temp dir should resolve")
}
