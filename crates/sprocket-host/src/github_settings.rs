use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use convex::Value;
use sprocket_workspace::github::saved_tokens::{self, LoadFuture, SavedTokens};
use sprocket_workspace::github::{self, GitHubSettings};

use crate::machine_identity::MachineIdentity;
use crate::native_auth::NativeAuthManager;
use crate::transcript_client::UserConvexClient;

const FILE_NAME: &str = "github-settings.json";

/// Keeps this machine's Settings → Version Control switches in the data dir
/// and hands them to the GitHub client.
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

/// Lets the GitHub client read the tokens a user saved, which Convex only
/// hands to a machine that proves the credential it registered with.
pub fn install_saved_tokens_loader(
    deployment_url: String,
    native_auth: Arc<NativeAuthManager>,
    identity: Arc<MachineIdentity>,
) {
    saved_tokens::install(Arc::new(move |user_id| -> LoadFuture {
        let deployment_url = deployment_url.clone();
        let native_auth = Arc::clone(&native_auth);
        let identity = Arc::clone(&identity);
        Box::pin(async move {
            let client = UserConvexClient::connect_with_fetcher(
                &deployment_url,
                native_auth.auth_token_fetcher_for_user(user_id),
            )
            .await?;
            client
                .act::<SavedTokens>(
                    "githubCredentials:issueTokens",
                    BTreeMap::from([
                        (
                            "machineId".to_string(),
                            Value::from(identity.installation_id.clone()),
                        ),
                        (
                            "credential".to_string(),
                            Value::from(identity.credential.clone()),
                        ),
                    ]),
                )
                .await
        })
    }));
}
