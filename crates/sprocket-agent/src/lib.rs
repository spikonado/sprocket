mod analytics;
mod catalog;
mod chatgpt;
mod context_handoff;
mod convex;
mod gateway;
mod history;
mod hooks;
mod openai;
mod output;
mod provider;
mod reasoning;
mod run;
mod run_settings;
mod stream_recovery;
pub mod subagents;
mod submission;
mod tools;
mod types;
mod usage;
mod workspace_context;

pub use catalog::model_catalog;
pub use output::{RunOutcome, RunOutput};
pub use run::{AgentRun, finalize_failed_start, run_agent, start_agent_run};
pub use run_settings::{ModelSettings, ResolvedSettings, SettingsOverrides, resolve_settings};
pub use sprocket_convex::AuthTokenFetcher;
pub use types::CompletionProvider;
pub use types::RunAgentRequest;
pub use types::{ChatGptAccess, ChatGptCredentials, InstalledConnector, InstalledConnectors};

pub(crate) fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}
