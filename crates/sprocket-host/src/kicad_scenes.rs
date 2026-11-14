use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use sprocket_workspace::WorkspaceBytes;
use tokio::sync::Semaphore;

const CACHED_SCENES: usize = 4;

/// Encodes boards into PCB viewer scenes one at a time and keeps the most recent ones.
pub struct KiCadScenes {
    recent: Mutex<VecDeque<CachedScene>>,
    parsing: Arc<Semaphore>,
}

struct CachedScene {
    path: PathBuf,
    version: String,
    scene: Arc<[u8]>,
}

impl Default for KiCadScenes {
    fn default() -> Self {
        Self {
            recent: Mutex::default(),
            parsing: Arc::new(Semaphore::new(1)),
        }
    }
}

impl KiCadScenes {
    pub async fn scene(&self, board: WorkspaceBytes) -> anyhow::Result<Arc<[u8]>> {
        if let Some(scene) = self.cached(&board) {
            return Ok(scene);
        }
        let permit = Arc::clone(&self.parsing).acquire_owned().await?;
        if let Some(scene) = self.cached(&board) {
            return Ok(scene);
        }
        let WorkspaceBytes {
            path,
            bytes,
            version,
        } = board;
        // The permit moves into the task so a dropped request can't start a second parse.
        let scene: Arc<[u8]> = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            sprocket_kicad::pcb_scene(&bytes)
        })
        .await??
        .into();
        let mut recent = self.recent();
        recent.retain(|cached| cached.path != path);
        recent.push_front(CachedScene {
            path,
            version,
            scene: Arc::clone(&scene),
        });
        recent.truncate(CACHED_SCENES);
        Ok(scene)
    }

    fn cached(&self, board: &WorkspaceBytes) -> Option<Arc<[u8]>> {
        let mut recent = self.recent();
        let index = recent
            .iter()
            .position(|cached| cached.path == board.path && cached.version == board.version)?;
        let cached = recent.remove(index)?;
        let scene = Arc::clone(&cached.scene);
        recent.push_front(cached);
        Some(scene)
    }

    fn recent(&self) -> MutexGuard<'_, VecDeque<CachedScene>> {
        self.recent.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
