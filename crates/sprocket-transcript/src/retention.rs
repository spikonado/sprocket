use std::fs::{self, File};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use super::attachment_store::PENDING_ATTACHMENTS_DIR;
use super::store::TranscriptStore;

const LAST_OPENED_FILE: &str = "last-opened";

/// The marker's modification time is the thread's last open on this machine.
pub(super) fn mark_opened(dir: &Path) -> io::Result<()> {
    File::options()
        .create(true)
        .append(true)
        .open(dir.join(LAST_OPENED_FILE))?
        .set_modified(SystemTime::now())
}

impl TranscriptStore {
    /// Open threads stay, which includes runs on this machine because a run watches its transcript.
    pub async fn remove_threads_opened_before(&self, cutoff: SystemTime) -> anyhow::Result<()> {
        let root = self.root();
        let dirs = tokio::task::spawn_blocking(move || thread_dirs(&root)).await??;
        for dir in dirs {
            let Some(idle) = self.lock_idle_thread(&dir).await else {
                continue;
            };
            tokio::task::spawn_blocking(move || {
                let _idle = idle;
                if let Err(error) = remove_if_opened_before(&dir, cutoff) {
                    tracing::warn!("failed to remove cached thread {}: {error}", dir.display());
                }
            })
            .await?;
        }
        Ok(())
    }
}

fn thread_dirs(root: &Path) -> io::Result<Vec<PathBuf>> {
    let users = match fs::read_dir(root) {
        Ok(users) => users,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut dirs = Vec::new();
    for user in users {
        let user = user?;
        if !user.file_type()?.is_dir() {
            continue;
        }
        for thread in fs::read_dir(user.path())? {
            let thread = thread?;
            if thread.file_type()?.is_dir() && thread.file_name() != PENDING_ATTACHMENTS_DIR {
                dirs.push(thread.path());
            }
        }
    }
    Ok(dirs)
}

fn remove_if_opened_before(dir: &Path, cutoff: SystemTime) -> io::Result<()> {
    match fs::metadata(dir.join(LAST_OPENED_FILE)) {
        Ok(marker) if marker.modified()? < cutoff => fs::remove_dir_all(dir),
        Ok(_) => Ok(()),
        // Directory times record writes, not opens, so caches from before the marker
        // start their retention now.
        Err(error) if error.kind() == ErrorKind::NotFound => mark_opened(dir),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests;
