use std::path::{Path, PathBuf};
use std::sync::Arc;

use sprocket_workspace::github::{self, GitHubSettings};

const FILE_NAME: &str = "github-settings.json";

/// Keeps Settings → Version Control in a private data-dir file, since it can
/// hold tokens, and hands it to the GitHub client.
pub struct GitHubSettingsStore {
    path: PathBuf,
    write_lock: tokio::sync::Mutex<()>,
}

impl GitHubSettingsStore {
    /// Unreadable settings fall back to the defaults so GitHub keeps working;
    /// the next change overwrites the file.
    pub fn load(data_dir: &Path) -> Arc<Self> {
        let path = data_dir.join(FILE_NAME);
        match read(&path) {
            Ok(settings) => github::apply_settings(settings),
            Err(error) => tracing::warn!(
                "ignoring unreadable GitHub settings at {}: {error:#}",
                path.display()
            ),
        }
        Arc::new(Self {
            path,
            write_lock: tokio::sync::Mutex::new(()),
        })
    }

    pub async fn update(&self, change: impl FnOnce(&mut GitHubSettings)) -> anyhow::Result<()> {
        let _guard = self.write_lock.lock().await;
        let mut settings = github::settings();
        change(&mut settings);
        settings
            .hosts
            .retain(|_, host| host.disabled || host.token.is_some());
        let bytes = serde_json::to_vec_pretty(&settings)?;
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || crate::profile::write_private_file(&path, &bytes))
            .await??;
        github::apply_settings(settings);
        Ok(())
    }
}

fn read(path: &Path) -> anyhow::Result<GitHubSettings> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(GitHubSettings::default()),
        Err(error) => Err(error.into()),
    }
}
