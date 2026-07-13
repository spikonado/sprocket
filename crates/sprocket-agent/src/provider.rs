use std::path::PathBuf;

use anyhow::anyhow;
use futures::StreamExt;
use rig::client::CompletionClient;
use rig::completion::{CompletionModel, Message};
use rig::streaming::{StreamedAssistantContent, StreamingPrompt};
use sprocket_convex_provider::Client as ConvexProviderClient;

use crate::convex::RuntimeClient;
use crate::hooks::{AgentPromptHook, ToolCallTracker};
use crate::tools::workspace_tools;
use crate::types::{RunAgentRequest, RunContextResponse};

const AGENT_MAX_TURNS: usize = 75;
const MAX_INVALID_TOOL_CALL_RETRIES: usize = 3;

/// Must match `RUN_CANCELLED_BY_USER` in `apps/web/src/convex/lib/agentErrors.ts`.
const RUN_CANCELLED_BY_USER: &str = "Run is cancelled.";
/// Must match `RUN_NO_LONGER_ACTIVE` in `apps/web/src/convex/lib/agentErrors.ts`.
const RUN_NO_LONGER_ACTIVE: &str = "Run is no longer active.";

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
    pub(crate) prompt: String,
    pub(crate) preamble: String,
    pub(crate) prior_history: Vec<Message>,
    pub(crate) workspace_root: PathBuf,
}

pub(crate) enum AgentProviderResult {
    Completed { text: String },
    Cancelled { text: String },
    Failed { text: String, error: anyhow::Error },
}

impl AgentProvider {
    pub(crate) fn default_for_run(
        runtime: &RuntimeClient,
        request: &RunAgentRequest,
        context: &RunContextResponse,
        run_id: &str,
    ) -> Self {
        Self {
            kind: ProviderKind::DEFAULT,
            completion: runtime
                .completion_client()
                .clone()
                .with_reasoning_effort(context.run.reasoning_effort.clone())
                .with_stream_target(Some(run_id.to_string()), request.guest_id.clone()),
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
    let tools = workspace_tools(
        runtime.clone(),
        request.run_id.clone(),
        request.workspace_root.clone(),
        tool_call_tracker.clone(),
    );
    let agent = completion_client
        .agent(model)
        .preamble(&request.preamble)
        .tool(tools.exec_command)
        .tool(tools.create_file)
        .tool(tools.replace_in_file)
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
                let error_text = error.to_string();
                if error_text.contains(RUN_CANCELLED_BY_USER)
                    || error_text.contains(RUN_NO_LONGER_ACTIVE)
                {
                    return AgentProviderResult::Cancelled { text };
                }
                return AgentProviderResult::Failed {
                    text,
                    error: anyhow!(error),
                };
            }
        }
    }

    if final_text.is_empty() {
        final_text = streamed_text;
    }

    AgentProviderResult::Completed { text: final_text }
}
