pub mod agent_launch;
pub mod artifact_watch;
pub mod browser;
mod browser_install;
mod bun_install;
pub mod chatgpt_credentials;
pub mod claude_code_cli;
mod cli_install;
pub mod command_sessions;
pub mod command_sync;
mod desktop_install;
pub mod device_sign_in;
mod gh_install;
mod git_install;
pub mod github_connector;
pub mod kicad_connector;
pub mod lifetime;
pub mod machine_identity;
pub mod machines;
pub mod muse_cli;
pub mod native_auth;
pub mod package_update;
pub mod profile;
pub mod project_attachments;
mod python_install;
pub mod run_recovery;
mod subagent_launcher;
mod tool_install;
pub mod transcript_client;
pub mod transcript_watch;
pub mod vercel_connector;
mod watch_registry;
mod work_sync;
pub mod workspace_search;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sprocket_transcript::{LiveCompletionHub, TranscriptStore};
use tokio::task::JoinHandle;

use crate::artifact_watch::ArtifactWatchers;
use crate::browser::BrowserManager;
use crate::chatgpt_credentials::ChatGptService;
use crate::claude_code_cli::ClaudeCodeCli;
use crate::command_sessions::ThreadCommandSessions;
use crate::github_connector::GitHubConnector;
use crate::kicad_connector::KiCadConnector;
use crate::lifetime::HostLifetime;
use crate::machine_identity::MachineIdentity;
use crate::machines::MachineManager;
use crate::muse_cli::MuseCli;
use crate::native_auth::{BrowserSessions, NativeAuthManager};
use crate::package_update::PackageUpdateManager;
use crate::project_attachments::{ProjectAttachmentRecord, ProjectAttachmentStore};
use crate::python_install::PythonTools;
use crate::run_recovery::RunRecovery;
pub use crate::tool_install::ToolInstall;
use crate::tool_install::{PinnedTool, append_path, prepend_path};
use crate::transcript_client::UserConvexClient;
use crate::transcript_watch::TranscriptWatchers;
use crate::vercel_connector::VercelConnector;
use crate::workspace_search::WorkspaceSearchIndex;

pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) async fn run_to_completion<T: Send + 'static>(
    task: impl Future<Output = T> + Send + 'static,
) -> Result<T, tokio::task::JoinError> {
    tokio::spawn(task).await
}

pub struct HostConfig {
    pub data_dir: PathBuf,
    pub convex_deployment_url: String,
    pub native_login_callback_url: String,
    pub browser_sessions: Option<Arc<dyn BrowserSessions>>,
    pub temporary: bool,
}

#[derive(Clone)]
pub struct Host {
    pub lifetime: Arc<HostLifetime>,
    pub native_auth: Arc<NativeAuthManager>,
    pub chatgpt_credentials: Arc<ChatGptService>,
    pub github: Arc<GitHubConnector>,
    pub vercel: Arc<VercelConnector>,
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
    pub browsers: Arc<BrowserManager>,
    pub kicad: Arc<KiCadConnector>,
    pub claude_code_cli: Arc<ClaudeCodeCli>,
    pub claude_code: sprocket_agent::ClaudeCode,
    pub muse_cli: Arc<MuseCli>,
    pub muse: sprocket_agent::Muse,
    bun: Arc<PinnedTool>,
    desktop: Arc<PinnedTool>,
    gh: Arc<PinnedTool>,
    git: Option<Arc<PinnedTool>>,
    python: Arc<PythonTools>,
    repository_key_moves: Arc<tokio::sync::Mutex<()>>,
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
            PackageUpdateManager::from_env(config.temporary),
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
        let python = Arc::new(PythonTools::new(data_dir)?);
        let claude_code_cli = Arc::new(ClaudeCodeCli::new());
        let muse_cli = Arc::new(MuseCli::new());
        let gh = Arc::new(gh_install::installer(data_dir)?);
        sprocket_workspace::github::use_pinned_gh(gh_install::executable(&gh));
        Ok(Self {
            lifetime: HostLifetime::new(),
            chatgpt_credentials,
            github: GitHubConnector::load(data_dir, Arc::clone(&gh)),
            vercel: Arc::new(VercelConnector::new(data_dir)?),
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
            command_sessions: Arc::new(ThreadCommandSessions::new()),
            convex_deployment_url,
            machine_identity,
            run_recovery: RunRecovery::load(data_dir)?,
            package_updates,
            browsers: BrowserManager::new(data_dir.to_path_buf())?,
            kicad: Arc::new(KiCadConnector::new(data_dir, Arc::clone(&python))?),
            claude_code: sprocket_agent::ClaudeCode::new(
                Arc::clone(&claude_code_cli) as _,
                data_dir.join("claude-code"),
            ),
            claude_code_cli,
            muse: sprocket_agent::Muse::new(Arc::clone(&muse_cli) as _),
            muse_cli,
            bun: Arc::new(bun_install::installer(data_dir)?),
            desktop: Arc::new(desktop_install::installer(data_dir)?),
            gh,
            git: cfg!(windows)
                .then(|| git_install::installer(data_dir))
                .transpose()?
                .map(Arc::new),
            python,
            repository_key_moves: Arc::default(),
        })
    }

    pub fn prepare_tools(&self) {
        self.browsers.prepare_tools();
        self.bun.prepare();
        self.desktop.prepare();
        self.gh.prepare();
        self.vercel.prepare();
        if let Some(git) = &self.git {
            git.prepare();
        }
        self.python.prepare();
        self.kicad.prepare();
    }

    pub fn tool_environment(&self) -> Vec<(OsString, OsString)> {
        let mut environment = append_path(
            prepend_path(
                self.browsers.environment(),
                [
                    self.kicad.bin_dir(),
                    self.desktop.bin_dir(),
                    self.gh.bin_dir(),
                    self.vercel.bin_dir(),
                ],
            ),
            [self.bun.bin_dir()]
                .into_iter()
                .chain(self.python.bin_dirs())
                .chain(self.git.as_deref().map(git_install::path_dir)),
        );
        environment.extend(python_install::certificate_environment());
        environment
    }

    /// One line per installed connector, for the agent's workspace instructions.
    pub fn installed_connectors(&self) -> Vec<String> {
        [
            self.github.installed(),
            self.vercel.installed(),
            self.kicad.installed(),
        ]
        .into_iter()
        .flatten()
        .collect()
    }

    /// The user's skill directories, then those of skills that ship with connector tools.
    pub fn skills_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = sprocket_workspace::default_user_skills_dirs();
        dirs.push(self.vercel.skills_dir());
        dirs
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

    pub fn spawn_repository_key_moves(&self, projects: &[ProjectAttachmentRecord]) {
        let moves: Vec<_> = projects
            .iter()
            .filter(|project| project.previous_repository_key.is_some())
            .cloned()
            .collect();
        if moves.is_empty() {
            return;
        }
        let Ok(guard) = Arc::clone(&self.repository_key_moves).try_lock_owned() else {
            return;
        };
        let host = self.clone();
        tokio::spawn(async move {
            let _guard = guard;
            if let Err(error) = host.move_pending_repository_keys(moves).await {
                tracing::warn!("moving threads to a new repository key failed: {error:#}");
            }
        });
    }

    async fn move_pending_repository_keys(
        &self,
        moves: Vec<ProjectAttachmentRecord>,
    ) -> anyhow::Result<()> {
        let Some(session) = self.native_auth.browser_session(false).await? else {
            return Ok(());
        };
        let client = self.convex_client_for(&session.user.id).await?;
        for project in moves {
            self.move_repository_key(&client, &project).await?;
        }
        Ok(())
    }

    pub async fn move_repository_key(
        &self,
        client: &UserConvexClient,
        project: &ProjectAttachmentRecord,
    ) -> anyhow::Result<()> {
        let Some(from) = &project.previous_repository_key else {
            return Ok(());
        };
        client
            .mutate::<serde_json::Value>(
                "repositoryKeys:move",
                std::collections::BTreeMap::from([
                    ("from".into(), from.clone().into()),
                    ("to".into(), project.repository_key.clone().into()),
                ]),
            )
            .await?;
        self.project_attachments
            .finish_repository_key_move(&project.workspace_path, from)
            .await
    }

    /// Ends machine presence first because ending it needs the native token.
    /// The wait is bounded so a pending registration can't outlast the CLI's
    /// logout timeout; presence then expires on its own.
    pub async fn sign_out(&self) -> anyhow::Result<()> {
        let _ = tokio::time::timeout(Duration::from_secs(10), self.machines.end_all()).await;
        self.native_auth.sign_out().await
    }

    pub fn start(&self) -> HostTasks {
        self.prepare_tools();
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
            command_sync: command_sync::spawn(self.clone()),
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
    pub async fn shutdown(self) {
        let host = self.host;
        for task in [self.attachment_cleanup, self.recovery, self.command_cleanup] {
            task.abort();
            let _ = task.await;
        }
        host.command_sessions.stop_all().await;
        host.browsers.shutdown().await;
        self.command_sync.abort();
        let _ = self.command_sync.await;
        if let Err(error) =
            tokio::time::timeout(Duration::from_secs(10), command_sync::flush(&host))
                .await
                .unwrap_or_else(|error| Err(error.into()))
        {
            tracing::warn!("command sync remains pending on disk after shutdown: {error:#}");
        }
        host.machines.shutdown().await;
    }
}
