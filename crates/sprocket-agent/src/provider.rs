use std::path::PathBuf;

use anyhow::anyhow;
use futures::StreamExt;
use rig::client::CompletionClient;
use rig::completion::{CompletionModel, Message};
use rig::streaming::{StreamedAssistantContent, StreamingPrompt};
use sprocket_convex_provider::{Client as ConvexProviderClient, is_completion_stream_superseded};

use crate::convex::RuntimeClient;
use crate::hooks::{AgentPromptHook, ToolCallTracker};
use crate::tools::agent_tools;
use crate::types::RunContextResponse;

const AGENT_MAX_TURNS: usize = 1_000;
const MAX_INVALID_TOOL_CALL_RETRIES: usize = 3;

/// Must match `RUN_CANCELLED_BY_USER` in `apps/web/src/convex/lib/agentErrors.ts`.
const RUN_CANCELLED_BY_USER: &str = "Run is cancelled.";
/// Must match `RUN_NO_LONGER_ACTIVE` in `apps/web/src/convex/lib/agentErrors.ts`.
const RUN_NO_LONGER_ACTIVE: &str = "Run is no longer active.";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProviderErrorDisposition {
    Cancelled,
    Superseded,
    Failed,
}

fn classify_provider_error(error: &(impl std::fmt::Display + ?Sized)) -> ProviderErrorDisposition {
    if is_completion_stream_superseded(error) {
        return ProviderErrorDisposition::Superseded;
    }
    let error_text = error.to_string();
    if error_text.contains(RUN_CANCELLED_BY_USER) || error_text.contains(RUN_NO_LONGER_ACTIVE) {
        return ProviderErrorDisposition::Cancelled;
    }
    ProviderErrorDisposition::Failed
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderKind {
    ConvexCompletion,
}

impl ProviderKind {
    pub(crate) const DEFAULT: Self = Self::ConvexCompletion;

    pub(crate) fn as_str(self) -> &'static str {
        "convex-completion"
    }
}

pub(crate) struct AgentProvider {
    kind: ProviderKind,
    completion: ConvexProviderClient,
    model: String,
}

pub(crate) struct AgentProviderRequest {
    pub(crate) run_id: String,
    pub(crate) claim_id: String,
    pub(crate) prompt: Message,
    pub(crate) preamble: String,
    pub(crate) prior_history: Vec<Message>,
    pub(crate) workspace_root: PathBuf,
}

pub(crate) enum AgentProviderResult {
    Completed { text: String },
    Cancelled { text: String },
    Superseded { error: anyhow::Error },
    Failed { text: String, error: anyhow::Error },
}

impl AgentProvider {
    pub(crate) fn default_for_run(
        runtime: &RuntimeClient,
        context: &RunContextResponse,
        run_id: &str,
        claim_id: &str,
    ) -> Self {
        Self {
            kind: ProviderKind::DEFAULT,
            completion: runtime
                .completion_client()
                .clone()
                .with_reasoning_effort(context.run.reasoning_effort.clone())
                .with_service_tier(context.run.service_tier.clone())
                .with_completion_scope(run_id.to_string(), claim_id.to_string()),
            model: context.run.selected_model.clone(),
        }
    }

    pub(crate) fn kind(&self) -> ProviderKind {
        self.kind
    }

    pub(crate) async fn run(
        self,
        runtime: RuntimeClient,
        request: AgentProviderRequest,
    ) -> AgentProviderResult {
        run_with_completion_client(self.completion, self.model, runtime, request).await
    }
}

async fn run_with_completion_client<C>(
    completion_client: C,
    model: String,
    runtime: RuntimeClient,
    request: AgentProviderRequest,
) -> AgentProviderResult
where
    C: CompletionClient,
    C::CompletionModel: CompletionModel<Client = C> + 'static,
    <C::CompletionModel as CompletionModel>::StreamingResponse: 'static,
{
    let tool_call_tracker = ToolCallTracker::default();
    let tools = agent_tools(
        runtime.clone(),
        request.run_id.clone(),
        request.claim_id.clone(),
        request.workspace_root.clone(),
        tool_call_tracker.clone(),
    );
    let command_sessions = tools.command_sessions.clone();
    let agent = completion_client
        .agent(model)
        .preamble(&request.preamble)
        .tool(tools.apply_patch)
        .tool(tools.exec_command)
        .tool(tools.scrape_url)
        .tool(tools.web_search)
        .tool(tools.write_stdin)
        .build();

    eprintln!("sprocket-agent: built agent {}", request.run_id);
    eprintln!("sprocket-agent: prompting model {}", request.run_id);

    let hook = AgentPromptHook::new(tool_call_tracker);

    let mut stream = agent
        .stream_prompt(request.prompt)
        .history(request.prior_history)
        .max_turns(AGENT_MAX_TURNS)
        .add_hook(hook)
        .max_invalid_tool_call_retries(MAX_INVALID_TOOL_CALL_RETRIES)
        .await;
    let mut final_text = String::new();
    let mut streamed_text = String::new();

    let result = 'agent_run: {
        while let Some(item) = stream.next().await {
            match item {
                Ok(rig::agent::MultiTurnStreamItem::FinalResponse(response)) => {
                    final_text = response.output().to_string();
                }
                Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(
                    StreamedAssistantContent::Text(text),
                )) => {
                    streamed_text.push_str(&text.text);
                }
                // Model tool calls are persisted by the Convex completion action. Tool execution
                // and results are persisted by executor jobs and correlated during finalization.
                Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(
                    StreamedAssistantContent::ToolCall { .. }
                    | StreamedAssistantContent::ToolCallDelta { .. }
                    | StreamedAssistantContent::Reasoning(_)
                    | StreamedAssistantContent::ReasoningDelta { .. }
                    | StreamedAssistantContent::Final(_)
                    | StreamedAssistantContent::Unknown(_),
                ))
                | Ok(rig::agent::MultiTurnStreamItem::ToolExecutionStart { .. })
                | Ok(rig::agent::MultiTurnStreamItem::StreamUserItem(_))
                | Ok(rig::agent::MultiTurnStreamItem::CompletionCall(_)) => {}
                Ok(_) => {}
                Err(error) => {
                    let text = if final_text.is_empty() {
                        streamed_text
                    } else {
                        final_text
                    };
                    let result = match classify_provider_error(&error) {
                        ProviderErrorDisposition::Superseded => AgentProviderResult::Superseded {
                            error: anyhow!(error),
                        },
                        ProviderErrorDisposition::Cancelled => {
                            AgentProviderResult::Cancelled { text }
                        }
                        ProviderErrorDisposition::Failed => AgentProviderResult::Failed {
                            text,
                            error: anyhow!(error),
                        },
                    };
                    break 'agent_run result;
                }
            }
        }

        if final_text.is_empty() {
            final_text = streamed_text;
        }

        AgentProviderResult::Completed { text: final_text }
    };

    command_sessions.stop_all().await;
    result
}

#[cfg(test)]
mod tests {
    use super::{ProviderErrorDisposition, RUN_NO_LONGER_ACTIVE, classify_provider_error};
    use sprocket_convex_provider::COMPLETION_STREAM_SUPERSEDED;

    #[test]
    fn classifies_superseded_completion_without_treating_it_as_failure() {
        let error = anyhow::anyhow!("completion provider failed: {COMPLETION_STREAM_SUPERSEDED}");

        assert_eq!(
            classify_provider_error(&error),
            ProviderErrorDisposition::Superseded
        );
    }

    #[test]
    fn classifies_stopped_workspace_tool_as_cancellation() {
        let error = anyhow::anyhow!("tool execution failed: {RUN_NO_LONGER_ACTIVE}");

        assert_eq!(
            classify_provider_error(&error),
            ProviderErrorDisposition::Cancelled
        );
    }
}
