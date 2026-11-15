use std::sync::Arc;

use sprocket_workspace::WorkspaceBytes;
use tokio::sync::Semaphore;

use crate::kicad_cache::KiCadCache;

/// Encodes boards into PCB viewer scenes one at a time and keeps the most recent ones.
pub struct KiCadScenes {
    recent: KiCadCache,
    parsing: Arc<Semaphore>,
}

impl Default for KiCadScenes {
    fn default() -> Self {
        Self {
            recent: KiCadCache::default(),
            parsing: Arc::new(Semaphore::new(1)),
        }
    }
}

impl KiCadScenes {
    pub async fn scene(&self, board: WorkspaceBytes) -> anyhow::Result<Arc<[u8]>> {
        if let Some(scene) = self.recent.get(&board.path, &board.version) {
            return Ok(scene);
        }
        let permit = Arc::clone(&self.parsing).acquire_owned().await?;
        if let Some(scene) = self.recent.get(&board.path, &board.version) {
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
        self.recent.insert(path, version, Arc::clone(&scene));
        Ok(scene)
    }
}
