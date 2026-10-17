//! Sprocket's machine-side services: auth, agent launch, transcript and
//! artifact sync, and command sessions, independent of the HTTP server.

pub mod agent_launch;
pub mod artifact_watch;
pub mod chatgpt_credentials;
pub mod command_sessions;
pub mod command_sync;
pub mod github_settings;
pub mod lifetime;
pub mod machine_identity;
pub mod machines;
pub mod native_auth;
pub mod package_update;
pub mod profile;
pub mod project_attachments;
pub mod run_recovery;
mod subagent_launcher;
pub mod transcript_client;
pub mod transcript_watch;
mod watch_registry;
mod work_sync;
pub mod workspace_search;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sprocket_transcript::{LiveCompletionHub, TranscriptStore};
use tokio::task::JoinHandle;

use crate::artifact_watch::ArtifactWatchers;
use crate::chatgpt_credentials::ChatGptService;
use crate::command_sessions::ThreadCommandSessions;
use crate::github_settings::GitHubSettingsStore;
use crate::lifetime::HostLifetime;
use crate::machine_identity::MachineIdentity;
use crate::machines::MachineManager;
use crate::native_auth::{BrowserSessions, NativeAuthManager};
use crate::package_update::PackageUpdateManager;
use crate::project_attachments::ProjectAttachmentStore;
use crate::run_recovery::RunRecovery;
use crate::transcript_client::UserConvexClient;
use crate::transcript_watch::TranscriptWatchers;
use crate::workspace_search::WorkspaceSearchIndex;

pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub struct HostConfig {
    pub data_dir: PathBuf,
    pub convex_deployment_url: String,
    pub native_login_callback_url: String,
    pub browser_sessions: Option<Arc<dyn BrowserSessions>>,
}

#[derive(Clone)]
pub struct Host {
    pub lifetime: Arc<HostLifetime>,
    pub native_auth: Arc<NativeAuthManager>,
    pub chatgpt_credentials: Arc<ChatGptService>,
    pub github_settings: Arc<GitHubSettingsStore>,
    pub project_attachments: Arc<ProjectAttachmentStore>,
    pub transcript: Arc<TranscriptStore>,
    pub transcript_watchers: Arc<TranscriptWatchers>,
    pub artifact_watchers: Arc<ArtifactWatchers>,
    pub workspace_search: Arc<WorkspaceSearchIndex>,
    pub machines: Arc<MachineManager>,
    pub live_completions: Arc<LiveCompletionHub>,
    pub command_sessions: Arc<ThreadCommandSessions>,
    pub convex_deployment_url: String,
    pub machine_identity: Arc<MachineIdentity>,
    pub run_recovery: Arc<RunRecovery>,
    pub package_updates: Arc<PackageUpdateManager>,
}

impl Host {
    pub fn load(config: HostConfig) -> anyhow::Result<Self> {
        let native_auth = NativeAuthManager::new(
            config.convex_deployment_url.clone(),
            config.native_login_callback_url,
            &config.data_dir,
            config.browser_sessions,
        );
        Self::assemble(
            native_auth,
            &config.data_dir,
            config.convex_deployment_url,
            ChatGptService::load_or_unavailable(&config.data_dir)?,
            PackageUpdateManager::from_env(),
        )
    }

    fn assemble(
        native_auth: Arc<NativeAuthManager>,
        data_dir: &Path,
        convex_deployment_url: String,
        chatgpt_credentials: Arc<ChatGptService>,
        package_updates: Arc<PackageUpdateManager>,
    ) -> anyhow::Result<Self> {
        let machine_identity = Arc::new(MachineIdentity::load(data_dir)?);
        let transcript = TranscriptStore::new(data_dir.join("transcripts"));
        Ok(Self {
            lifetime: HostLifetime::new(),
            chatgpt_credentials,
            github_settings: GitHubSettingsStore::load(data_dir),
            project_attachments: ProjectAttachmentStore::new(data_dir.to_path_buf()),
            transcript_watchers: TranscriptWatchers::new(
                convex_deployment_url.clone(),
                Arc::clone(&transcript),
                Arc::clone(&native_auth),
            ),
            artifact_watchers: ArtifactWatchers::new(
                convex_deployment_url.clone(),
                Arc::clone(&native_auth),
                data_dir.join("artifact-bindings"),
            ),
            transcript,
            workspace_search: Arc::new(WorkspaceSearchIndex::new()),
            machines: MachineManager::new(
                convex_deployment_url.clone(),
                Arc::clone(&native_auth),
                Arc::clone(&machine_identity),
            ),
            native_auth,
            live_completions: Arc::new(LiveCompletionHub::new()),
            command_sessions: Arc::new(ThreadCommandSessions::default()),
            convex_deployment_url,
            machine_identity,
            run_recovery: RunRecovery::load(data_dir)?,
            package_updates,
        })
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn for_test(
        native_auth: Arc<NativeAuthManager>,
        data_dir: &Path,
        package_updates: Arc<PackageUpdateManager>,
    ) -> Self {
        Self::assemble(
            native_auth,
            data_dir,
            "https://example.convex.cloud".to_string(),
            ChatGptService::load_or_unavailable(data_dir).expect("ChatGPT credential service"),
            package_updates,
        )
        .expect("test host")
    }

    pub async fn convex_client_for(&self, user_id: &str) -> anyhow::Result<UserConvexClient> {
        UserConvexClient::connect_with_fetcher(
            &self.convex_deployment_url,
            self.native_auth
                .auth_token_fetcher_for_user(user_id.to_string()),
        )
        .await
    }

    /// Starts the background work that keeps local state in sync with the cloud.
    pub fn start(&self) -> HostTasks {
        let transcript = Arc::clone(&self.transcript);
        let attachment_cleanup = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60 * 60));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let cutoff = std::time::SystemTime::now() - Duration::from_secs(24 * 60 * 60);
                if let Err(error) = transcript.prune_pending_attachments(cutoff).await {
                    eprintln!("sprocket-server: failed to expire pending attachments: {error}");
                }
            }
        });
        let command_sessions = Arc::clone(&self.command_sessions);
        let command_cleanup = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                command_sessions.prune().await;
            }
        });
        HostTasks {
            command_sync: command_sync::spawn(
                Arc::clone(&self.transcript),
                Arc::clone(&self.command_sessions),
                Arc::clone(&self.native_auth),
                self.convex_deployment_url.clone(),
                self.machine_identity.installation_id.clone(),
            ),
            recovery: run_recovery::spawn(self.clone()),
            host: self.clone(),
            attachment_cleanup,
            command_cleanup,
        }
    }
}

pub struct HostTasks {
    host: Host,
    attachment_cleanup: JoinHandle<()>,
    command_cleanup: JoinHandle<()>,
    command_sync: JoinHandle<()>,
    recovery: JoinHandle<()>,
}

impl HostTasks {
    /// Stops background work, ends running commands, and flushes their logs.
    pub async fn shutdown(self) {
        let host = self.host;
        for task in [self.attachment_cleanup, self.recovery, self.command_cleanup] {
            task.abort();
            let _ = task.await;
        }
        host.command_sessions.stop_all().await;
        self.command_sync.abort();
        let _ = self.command_sync.await;
        if let Err(error) = tokio::time::timeout(
            Duration::from_secs(10),
            command_sync::flush(
                &host.transcript,
                &host.command_sessions,
                &host.native_auth,
                &host.convex_deployment_url,
                &host.machine_identity.installation_id,
            ),
        )
        .await
        .unwrap_or_else(|error| Err(error.into()))
        {
            tracing::warn!("command sync remains pending on disk after shutdown: {error:#}");
        }
        host.machines.shutdown().await;
    }
}
