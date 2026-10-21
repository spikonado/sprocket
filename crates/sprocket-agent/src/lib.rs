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
mod stream_recovery;
pub mod subagents;
mod submission;
mod tools;
mod types;
mod usage;

pub use output::{RunOutcome, RunOutput};
pub use run::{AgentRun, finalize_failed_start, run_agent, start_agent_run};
pub use sprocket_convex::AuthTokenFetcher;
pub use types::CompletionProvider;
pub use types::RunAgentRequest;
pub use types::{ChatGptAccess, ChatGptCredentials};

pub(crate) fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}
