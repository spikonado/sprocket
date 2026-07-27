use std::path::PathBuf;
use std::sync::Arc;

use anyhow::anyhow;
use futures::StreamExt;
use rig::client::CompletionClient;
use rig::completion::{CompletionModel, Message};
use rig::providers::{chatgpt, openai};
use rig::streaming::{StreamedAssistantContent, StreamingPrompt};
use serde_json::json;
use sprocket_convex_provider::{ConvexStreamSync, is_completion_stream_superseded};
use sprocket_workspace::{CommandSessionManager, WorkspaceSkill};
use uuid::Uuid;

use crate::compaction::ContextCompactionHook;
use crate::convex::RuntimeClient;
use crate::hooks::{AgentPromptHook, ToolCallTracker};
use crate::tools::agent_tools;
use crate::transcript_sync::TranscriptSyncHook;
use crate::types::{AvailableProvider, ContextBudget, RunContextResponse};

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
    Convex,
    ChatGPT,
    OpenAI,
}

impl ProviderKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Convex => "convex",
            Self::ChatGPT => "chatgpt",
            Self::OpenAI => "openai",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        match id {
            "convex" => Some(Self::Convex),
            "chatgpt" => Some(Self::ChatGPT),
            "openai" => Some(Self::OpenAI),
            _ => None,
        }
    }

    fn serves_model(self, model_provider: &str) -> bool {
        match self {
            Self::Convex => true,
            Self::ChatGPT | Self::OpenAI => model_provider == "openai",
        }
    }

    fn requires_credential(self) -> bool {
        matches!(self, Self::ChatGPT | Self::OpenAI)
    }
}

pub(crate) struct AgentProviderRequest {
    pub(crate) run_id: String,
    pub(crate) claim_id: String,
    pub(crate) prompt: Message,
    pub(crate) preamble: String,
    pub(crate) prior_history: Vec<Message>,
    pub(crate) workspace_root: PathBuf,
    pub(crate) skills: Arc<[WorkspaceSkill]>,
    pub(crate) model: String,
    pub(crate) reasoning_effort: String,
    pub(crate) service_tier: String,
    pub(crate) context_budget: ContextBudget,
}

pub(crate) enum AgentProviderResult {
    Completed {
        text: String,
    },
    Cancelled {
        text: String,
    },
    Superseded {
        error: anyhow::Error,
    },
    Failed {
        text: String,
        error: anyhow::Error,
        /// False once durable stream events were merged for this provider try.
        allow_provider_fallback: bool,
    },
}

pub(crate) async fn run_with_provider_fallback(
    runtime: RuntimeClient,
    context: &RunContextResponse,
    request: AgentProviderRequest,
) -> AgentProviderResult {
    let candidates = provider_candidates(
        &context.provider_preference,
        &context.available_providers,
        &context.model_provider,
    );
    if candidates.is_empty() {
        return AgentProviderResult::Failed {
            text: String::new(),
            error: anyhow!("no configured providers can serve this model"),
            allow_provider_fallback: false,
        };
    }

    let mut superseded_stream_ids: Vec<String> = Vec::new();
    let mut last_failure: Option<AgentProviderResult> = None;

    for (index, kind) in candidates.iter().copied().enumerate() {
        eprintln!(
            "sprocket-agent: trying provider {} for run {}",
            kind.as_str(),
            request.run_id
        );
        let result = match kind {
            ProviderKind::Convex => {
                run_convex_provider(runtime.clone(), &request, &mut superseded_stream_ids).await
            }
            ProviderKind::ChatGPT => {
                run_chatgpt_provider(runtime.clone(), &request, &mut superseded_stream_ids).await
            }
            ProviderKind::OpenAI => {
                run_openai_provider(runtime.clone(), &request, &mut superseded_stream_ids).await
            }
        };

        match result {
            AgentProviderResult::Completed { .. }
            | AgentProviderResult::Cancelled { .. }
            | AgentProviderResult::Superseded { .. } => return result,
            AgentProviderResult::Failed {
                text,
                error,
                allow_provider_fallback,
            } => {
                let can_fallback =
                    index + 1 < candidates.len() && text.is_empty() && allow_provider_fallback;
                if can_fallback {
                    eprintln!(
                        "sprocket-agent: provider {} failed before durable stream merge; falling back: {error:#}",
                        kind.as_str()
                    );
                    last_failure = Some(AgentProviderResult::Failed {
                        text,
                        error,
                        allow_provider_fallback,
                    });
                    continue;
                }
                return AgentProviderResult::Failed {
                    text,
                    error,
                    allow_provider_fallback,
                };
            }
        }
    }

    last_failure.unwrap_or(AgentProviderResult::Failed {
        text: String::new(),
        error: anyhow!("all providers failed"),
        allow_provider_fallback: false,
    })
}

fn provider_candidates(
    preference: &[String],
    available: &[AvailableProvider],
    model_provider: &str,
) -> Vec<ProviderKind> {
    let configured: std::collections::HashSet<&str> = available
        .iter()
        .filter(|provider| provider.configured)
        .map(|provider| provider.id.as_str())
        .collect();
    let mut ordered = Vec::new();
    for id in preference {
        let Some(kind) = ProviderKind::from_id(id) else {
            continue;
        };
        if !kind.serves_model(model_provider) {
            continue;
        }
        if kind.requires_credential() && !configured.contains(kind.as_str()) {
            continue;
        }
        if !ordered.contains(&kind) {
            ordered.push(kind);
        }
    }
    ordered
}

async fn run_convex_provider(
    runtime: RuntimeClient,
    request: &AgentProviderRequest,
    superseded_stream_ids: &mut Vec<String>,
) -> AgentProviderResult {
    let sequence_before = runtime
        .completion_stream_sequence(&request.run_id)
        .await
        .unwrap_or(0);
    let completion = runtime
        .completion_client()
        .clone()
        .with_reasoning_effort(request.reasoning_effort.clone())
        .with_service_tier(request.service_tier.clone())
        .with_completion_scope(request.run_id.clone(), request.claim_id.clone())
        .with_superseded_stream_ids(superseded_stream_ids.iter().cloned());
    let result = run_with_completion_client(
        completion,
        request.model.clone(),
        runtime.clone(),
        request,
        None,
        None,
        None,
    )
    .await;
    let attempted_stream_ids = runtime
        .completion_client()
        .take_attempted_stream_ids()
        .await;
    let sequence_after = runtime
        .completion_stream_sequence(&request.run_id)
        .await
        .unwrap_or(sequence_before);
    let merged_any = sequence_after > sequence_before;
    match result {
        AgentProviderResult::Failed {
            text,
            error,
            allow_provider_fallback: _,
        } if !merged_any => {
            superseded_stream_ids.extend(attempted_stream_ids);
            AgentProviderResult::Failed {
                text,
                error,
                allow_provider_fallback: true,
            }
        }
        AgentProviderResult::Failed { text, error, .. } => AgentProviderResult::Failed {
            text,
            error,
            allow_provider_fallback: false,
        },
        other => other,
    }
}

async fn run_openai_provider(
    runtime: RuntimeClient,
    request: &AgentProviderRequest,
    superseded_stream_ids: &mut Vec<String>,
) -> AgentProviderResult {
    let credential = match runtime
        .get_openai_api_key(&request.run_id, &request.claim_id)
        .await
    {
        Ok(Some(api_key)) => api_key,
        Ok(None) => {
            return AgentProviderResult::Failed {
                text: String::new(),
                error: anyhow!("OpenAI API key is not configured"),
                allow_provider_fallback: true,
            };
        }
        Err(error) => {
            return AgentProviderResult::Failed {
                text: String::new(),
                error,
                allow_provider_fallback: true,
            };
        }
    };

    let openai = match openai::Client::new(&credential) {
        Ok(client) => client,
        Err(error) => {
            return AgentProviderResult::Failed {
                text: String::new(),
                error: anyhow!("failed to build OpenAI client: {error}"),
                allow_provider_fallback: true,
            };
        }
    };

    let additional_params = openai_additional_params(
        &request.reasoning_effort,
        &request.service_tier,
        &request.run_id,
    );
    run_local_provider(
        openai,
        runtime,
        request,
        superseded_stream_ids,
        Some(additional_params),
        Some(ByokCompactionAuth::OpenAIApiKey(credential)),
    )
    .await
}

async fn run_chatgpt_provider(
    runtime: RuntimeClient,
    request: &AgentProviderRequest,
    superseded_stream_ids: &mut Vec<String>,
) -> AgentProviderResult {
    let auth_json = match runtime
        .get_chatgpt_auth_json(&request.run_id, &request.claim_id)
        .await
    {
        Ok(Some(auth_json)) => auth_json,
        Ok(None) => {
            return AgentProviderResult::Failed {
                text: String::new(),
                error: anyhow!("ChatGPT auth is not configured"),
                allow_provider_fallback: true,
            };
        }
        Err(error) => {
            return AgentProviderResult::Failed {
                text: String::new(),
                error,
                allow_provider_fallback: true,
            };
        }
    };

    let auth_session = match ChatGPTAuthSession::create(
        runtime.clone(),
        request.run_id.clone(),
        request.claim_id.clone(),
        &auth_json,
    ) {
        Ok(session) => session,
        Err(error) => {
            return AgentProviderResult::Failed {
                text: String::new(),
                error,
                allow_provider_fallback: true,
            };
        }
    };

    let chatgpt = match chatgpt::Client::builder()
        .oauth()
        .auth_file(auth_session.path())
        .allow_device_flow(false)
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return AgentProviderResult::Failed {
                text: String::new(),
                error: anyhow!("failed to build ChatGPT client: {error}"),
                allow_provider_fallback: true,
            };
        }
    };

    let additional_params = chatgpt_additional_params(&request.reasoning_effort);
    let result = run_local_provider(
        chatgpt,
        runtime,
        request,
        superseded_stream_ids,
        Some(additional_params),
        Some(ByokCompactionAuth::ChatGPTAuthJson(auth_json)),
    )
    .await;
    auth_session.sync_back_if_changed().await;
    result
}

async fn run_local_provider<C>(
    completion_client: C,
    runtime: RuntimeClient,
    request: &AgentProviderRequest,
    superseded_stream_ids: &mut Vec<String>,
    additional_params: Option<serde_json::Value>,
    byok_compaction: Option<ByokCompactionAuth>,
) -> AgentProviderResult
where
    C: CompletionClient,
    C::CompletionModel: CompletionModel<Client = C> + 'static,
    <C::CompletionModel as CompletionModel>::StreamingResponse: 'static,
{
    let scoped_client = runtime
        .completion_client()
        .clone()
        .with_completion_scope(request.run_id.clone(), request.claim_id.clone());
    let sync = ConvexStreamSync::new(
        scoped_client,
        request.run_id.clone(),
        request.claim_id.clone(),
    );
    sync.seed_superseded_stream_ids(superseded_stream_ids.iter().cloned())
        .await;

    let transcript_hook = TranscriptSyncHook::new(sync.clone());
    let result = run_with_completion_client(
        completion_client,
        request.model.clone(),
        runtime,
        request,
        additional_params,
        Some(transcript_hook),
        byok_compaction,
    )
    .await;

    match result {
        AgentProviderResult::Failed { text, error, .. } if !sync.merged_any() => {
            sync.abandon_turn_without_merge().await;
            superseded_stream_ids.extend(sync.take_superseded_stream_ids().await);
            AgentProviderResult::Failed {
                text,
                error,
                allow_provider_fallback: true,
            }
        }
        AgentProviderResult::Failed { text, error, .. } => AgentProviderResult::Failed {
            text,
            error,
            allow_provider_fallback: false,
        },
        other => other,
    }
}

struct ChatGPTAuthSession {
    runtime: RuntimeClient,
    run_id: String,
    claim_id: String,
    path: PathBuf,
    original: String,
}

impl ChatGPTAuthSession {
    fn create(
        runtime: RuntimeClient,
        run_id: String,
        claim_id: String,
        auth_json: &str,
    ) -> anyhow::Result<Self> {
        let path = std::env::temp_dir().join(format!(
            "sprocket-chatgpt-auth-{}-{}.json",
            run_id,
            Uuid::new_v4()
        ));
        std::fs::write(&path, auth_json)
            .map_err(|error| anyhow!("failed to materialize ChatGPT auth.json: {error}"))?;
        Ok(Self {
            runtime,
            run_id,
            claim_id,
            path,
            original: auth_json.to_owned(),
        })
    }

    fn path(&self) -> &PathBuf {
        &self.path
    }

    async fn sync_back_if_changed(&self) {
        let Ok(current) = std::fs::read_to_string(&self.path) else {
            return;
        };
        if current == self.original {
            return;
        }
        if let Err(error) = self
            .runtime
            .update_chatgpt_auth(&self.run_id, &self.claim_id, &current)
            .await
        {
            eprintln!("sprocket-agent: failed to sync refreshed ChatGPT auth: {error:#}");
        }
    }
}

impl Drop for ChatGPTAuthSession {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn resolve_output_text(final_text: String, streamed_text: String) -> String {
    if final_text.is_empty() {
        streamed_text
    } else {
        final_text
    }
}

fn reasoning_effort_param(reasoning_effort: &str) -> &'static str {
    match reasoning_effort {
        "none" => "none",
        "low" => "low",
        "high" => "high",
        "xhigh" => "xhigh",
        "max" => "max",
        _ => "medium",
    }
}

fn openai_additional_params(
    reasoning_effort: &str,
    service_tier: &str,
    prompt_cache_key: &str,
) -> serde_json::Value {
    let service_tier = if service_tier == "fast" {
        "priority"
    } else {
        "default"
    };
    json!({
        "reasoning": { "effort": reasoning_effort_param(reasoning_effort) },
        "service_tier": service_tier,
        "prompt_cache_key": format!("thread-run:{prompt_cache_key}"),
    })
}

fn chatgpt_additional_params(reasoning_effort: &str) -> serde_json::Value {
    // ChatGPT backend is Responses-shaped but rejects several OpenAI API-only fields.
    json!({
        "reasoning": { "effort": reasoning_effort_param(reasoning_effort) },
    })
}

#[derive(Clone)]
enum ByokCompactionAuth {
    OpenAIApiKey(String),
    ChatGPTAuthJson(String),
}

async fn run_with_completion_client<C>(
    completion_client: C,
    model: String,
    runtime: RuntimeClient,
    request: &AgentProviderRequest,
    additional_params: Option<serde_json::Value>,
    transcript_hook: Option<TranscriptSyncHook>,
    byok_compaction: Option<ByokCompactionAuth>,
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
        request.skills.clone(),
    );
    let session_shutdown = CommandSessionShutdown::new(tools.command_sessions.clone());
    let mut agent = completion_client
        .agent(model)
        .preamble(&request.preamble)
        .tool(tools.apply_patch)
        .tool(tools.exec_command)
        .tool(tools.read_skill)
        .tool(tools.scrape_url)
        .tool(tools.web_search)
        .tool(tools.write_stdin);
    if let Some(params) = additional_params {
        agent = agent.additional_params(params);
    }
    let agent = agent.build();

    eprintln!("sprocket-agent: built agent {}", request.run_id);
    eprintln!("sprocket-agent: prompting model {}", request.run_id);

    let prompt_hook = AgentPromptHook::new(tool_call_tracker);
    let prior_history_len = request.prior_history.len();
    let mut compaction_hook = ContextCompactionHook::new(
        runtime,
        request.run_id.clone(),
        request.claim_id.clone(),
        request.model.clone(),
        request.reasoning_effort.clone(),
        request.service_tier.clone(),
        request.context_budget.clone(),
        prior_history_len,
    );
    match byok_compaction {
        Some(ByokCompactionAuth::OpenAIApiKey(api_key)) => {
            compaction_hook = compaction_hook.with_openai_api_key(api_key);
        }
        Some(ByokCompactionAuth::ChatGPTAuthJson(auth_json)) => {
            compaction_hook = compaction_hook.with_chatgpt_auth_json(auth_json);
        }
        None => {}
    }

    let mut stream_builder = agent
        .stream_prompt(request.prompt.clone())
        .history(request.prior_history.clone())
        .max_turns(AGENT_MAX_TURNS)
        .add_hook(prompt_hook)
        .add_hook(compaction_hook)
        .max_invalid_tool_call_retries(MAX_INVALID_TOOL_CALL_RETRIES);
    if let Some(hook) = &transcript_hook {
        stream_builder = stream_builder.add_hook(hook.clone());
    }
    let mut stream = stream_builder.await;
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
                Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(
                    StreamedAssistantContent::Reasoning(reasoning),
                )) => {
                    if let Some(hook) = &transcript_hook {
                        let text = reasoning.display_text();
                        if !text.is_empty()
                            && let Err(error) = hook
                                .sync()
                                .push_reasoning_delta(reasoning.id.as_deref(), &text)
                                .await
                        {
                            break 'agent_run AgentProviderResult::Failed {
                                text: resolve_output_text(final_text, streamed_text),
                                error,
                                allow_provider_fallback: false,
                            };
                        }
                    }
                }
                Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(
                    StreamedAssistantContent::ReasoningDelta { id, reasoning, .. },
                )) => {
                    if let Some(hook) = &transcript_hook
                        && let Err(error) = hook
                            .sync()
                            .push_reasoning_delta(id.as_deref(), &reasoning)
                            .await
                    {
                        break 'agent_run AgentProviderResult::Failed {
                            text: resolve_output_text(final_text, streamed_text),
                            error,
                            allow_provider_fallback: false,
                        };
                    }
                }
                Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(
                    StreamedAssistantContent::ToolCall { .. }
                    | StreamedAssistantContent::ToolCallDelta { .. }
                    | StreamedAssistantContent::Final(_)
                    | StreamedAssistantContent::Unknown(_),
                ))
                | Ok(rig::agent::MultiTurnStreamItem::ToolExecutionStart { .. })
                | Ok(rig::agent::MultiTurnStreamItem::StreamUserItem(_))
                | Ok(rig::agent::MultiTurnStreamItem::CompletionCall(_)) => {}
                Ok(_) => {}
                Err(error) => {
                    let text = resolve_output_text(final_text, streamed_text);
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
                            // OpenAI path overrides this from ConvexStreamSync::merged_any.
                            // Hosted Convex path overrides from streamSequence delta.
                            allow_provider_fallback: true,
                        },
                    };
                    break 'agent_run result;
                }
            }
        }

        AgentProviderResult::Completed {
            text: resolve_output_text(final_text, streamed_text),
        }
    };

    session_shutdown.finish().await;
    result
}

/// Stops persistent command sessions on the normal path and if this future is
/// dropped early (for example when claim lease renewal fails).
struct CommandSessionShutdown {
    sessions: Option<CommandSessionManager>,
}

impl CommandSessionShutdown {
    fn new(sessions: CommandSessionManager) -> Self {
        Self {
            sessions: Some(sessions),
        }
    }

    async fn finish(mut self) {
        if let Some(sessions) = self.sessions.as_ref() {
            sessions.stop_all().await;
        }
        self.sessions = None;
    }
}

impl Drop for CommandSessionShutdown {
    fn drop(&mut self) {
        if let Some(sessions) = self.sessions.take() {
            sessions.terminate_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ProviderErrorDisposition, ProviderKind, RUN_NO_LONGER_ACTIVE, classify_provider_error,
        provider_candidates,
    };
    use crate::types::AvailableProvider;
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

    #[test]
    fn builds_provider_candidates_from_preference_and_capabilities() {
        let available = [
            AvailableProvider {
                id: "convex".into(),
                configured: true,
            },
            AvailableProvider {
                id: "chatgpt".into(),
                configured: true,
            },
            AvailableProvider {
                id: "openai".into(),
                configured: true,
            },
        ];
        assert_eq!(
            provider_candidates(
                &["chatgpt".into(), "openai".into(), "convex".into()],
                &available,
                "openai"
            ),
            vec![
                ProviderKind::ChatGPT,
                ProviderKind::OpenAI,
                ProviderKind::Convex
            ]
        );
        assert_eq!(
            provider_candidates(
                &["chatgpt".into(), "openai".into(), "convex".into()],
                &available,
                "anthropic"
            ),
            vec![ProviderKind::Convex]
        );
        assert_eq!(
            provider_candidates(
                &["chatgpt".into(), "openai".into(), "convex".into()],
                &[
                    AvailableProvider {
                        id: "convex".into(),
                        configured: true,
                    },
                    AvailableProvider {
                        id: "openai".into(),
                        configured: true,
                    },
                ],
                "openai"
            ),
            vec![ProviderKind::OpenAI, ProviderKind::Convex]
        );
    }
}
