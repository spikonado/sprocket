use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::anyhow;
use futures::StreamExt;
use rig::client::{AgentClientExt, CompletionClient};
use rig::completion::{FinishReason, Message};
use rig::providers::openai;
use rig::streaming::{StreamedAssistantContent, StreamingPrompt};
use sprocket_workspace::{CommandSessionManager, WorkspaceSkill};
use tokio::time::sleep;

use crate::compaction::ContextCompactionHook;
use crate::convex::RuntimeClient;
use crate::hooks::{AgentPromptHook, GatewayRequestHook, ToolCallTracker};
use crate::live::{
    LiveAssistantPart, LiveAssistantParts, LiveCompletionHub, LiveCompletionOverlay,
    join_assistant_text_parts, now_ms,
};
use crate::reasoning::{apply_completed_reasoning, merge_provider_metadata};
use crate::tools::agent_tools;
use crate::types::{ContextBudget, RunContextResponse, gateway_api_v1_url};

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
    let error_text = error.to_string();
    if error_text.contains("SPROCKET_COMPLETION_STREAM_SUPERSEDED") {
        return ProviderErrorDisposition::Superseded;
    }
    if error_text.contains(RUN_CANCELLED_BY_USER) || error_text.contains(RUN_NO_LONGER_ACTIVE) {
        return ProviderErrorDisposition::Cancelled;
    }
    ProviderErrorDisposition::Failed
}

fn incomplete_completion_error(reason: Option<&FinishReason>) -> Option<anyhow::Error> {
    match reason {
        Some(FinishReason::Length) => Some(anyhow!(
            "The model response was cut off because it reached its output token limit."
        )),
        Some(FinishReason::ContentFilter) => Some(anyhow!(
            "The model response was blocked by a content filter."
        )),
        Some(FinishReason::Other(reason)) => {
            Some(anyhow!("The model stopped unexpectedly: {reason}"))
        }
        Some(FinishReason::Stop | FinishReason::ToolCalls) | None => None,
    }
}

pub(crate) struct AgentProvider {
    gateway_url: String,
    model: String,
}

pub(crate) struct AgentProviderRequest {
    pub(crate) run_id: String,
    pub(crate) claim_id: String,
    pub(crate) thread_id: String,
    pub(crate) run_started_at: u64,
    pub(crate) live: Arc<LiveCompletionHub>,
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
    Completed { text: String },
    Cancelled { text: String },
    Superseded { error: anyhow::Error },
    Failed { text: String, error: anyhow::Error },
}

impl AgentProvider {
    pub(crate) fn default_for_run(context: &RunContextResponse, gateway_url: &str) -> Self {
        Self {
            gateway_url: gateway_url.to_string(),
            model: context.run.selected_model.clone(),
        }
    }

    pub(crate) async fn run(
        self,
        runtime: RuntimeClient,
        request: AgentProviderRequest,
    ) -> AgentProviderResult {
        let credential = match runtime
            .issue_gateway_credential(&request.run_id, &request.claim_id)
            .await
        {
            Ok(credential) => credential,
            Err(error) => {
                return AgentProviderResult::Failed {
                    text: String::new(),
                    error,
                };
            }
        };
        let base_url = gateway_api_v1_url(&self.gateway_url);
        let completion_client = match openai::Client::builder()
            .api_key(credential.token)
            .base_url(&base_url)
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                return AgentProviderResult::Failed {
                    text: String::new(),
                    error: anyhow!(error),
                };
            }
        };
        run_with_completion_client(
            completion_client,
            self.model,
            runtime,
            request,
            self.gateway_url,
        )
        .await
    }
}

async fn run_with_completion_client<C>(
    completion_client: C,
    model: String,
    runtime: RuntimeClient,
    request: AgentProviderRequest,
    gateway_url: String,
) -> AgentProviderResult
where
    C: CompletionClient + AgentClientExt,
    C::CompletionModel: 'static,
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
    let agent = completion_client
        .agent(model)
        .preamble(&request.preamble)
        .tool(tools.apply_patch)
        .tool(tools.ask_question)
        .tool(tools.await_question)
        .tool(tools.exec_command)
        .tool(tools.read_skill)
        .tool(tools.scrape_url)
        .tool(tools.web_search)
        .tool(tools.write_stdin)
        .tool(tools.create_artifact)
        .tool(tools.update_artifact)
        .tool(tools.browser_act)
        .tool(tools.browser_observe)
        .tool(tools.browser_extract)
        .tool(tools.mandate_setup)
        .tool(tools.mandate_status)
        .tool(tools.mandate_list)
        .tool(tools.mandate_charge)
        .tool(tools.mandate_report)
        .build();

    eprintln!("sprocket-agent: built agent {}", request.run_id);
    eprintln!("sprocket-agent: prompting model {}", request.run_id);

    let persist_reasoning_replay = Arc::new(AtomicBool::new(true));
    let mut transcript = match TranscriptSink::start(
        runtime.clone(),
        request.live.clone(),
        request.run_id.clone(),
        request.claim_id.clone(),
        request.thread_id.clone(),
        request.run_started_at,
        persist_reasoning_replay.clone(),
    )
    .await
    {
        Ok(sink) => sink,
        Err(error) => {
            session_shutdown.finish().await;
            let result = match classify_provider_error(&error) {
                ProviderErrorDisposition::Superseded => AgentProviderResult::Superseded { error },
                ProviderErrorDisposition::Cancelled => AgentProviderResult::Cancelled {
                    text: String::new(),
                },
                ProviderErrorDisposition::Failed => AgentProviderResult::Failed {
                    text: String::new(),
                    error,
                },
            };
            return result;
        }
    };

    let prompt_hook = AgentPromptHook::new(tool_call_tracker);
    let prior_history_len = request.prior_history.len();
    let gateway_hook = GatewayRequestHook::new(
        request.reasoning_effort.clone(),
        request.service_tier.clone(),
    );
    let compaction_hook = ContextCompactionHook::new(
        runtime.clone(),
        request.run_id.clone(),
        request.claim_id.clone(),
        request.model,
        request.reasoning_effort,
        request.service_tier,
        request.context_budget,
        prior_history_len,
        gateway_url,
        persist_reasoning_replay,
    );

    let mut finished = match runtime.run_finished_subscription(&request.run_id).await {
        Ok(subscription) => subscription,
        Err(error) => {
            session_shutdown.finish().await;
            return AgentProviderResult::Failed {
                text: String::new(),
                error,
            };
        }
    };

    let mut stream = agent
        .stream_prompt(request.prompt)
        .history(request.prior_history)
        .max_turns(AGENT_MAX_TURNS)
        .add_hook(prompt_hook)
        .add_hook(gateway_hook)
        .add_hook(compaction_hook)
        .max_invalid_tool_call_retries(MAX_INVALID_TOOL_CALL_RETRIES)
        .await;
    let mut final_text = String::new();
    let mut streamed_text = String::new();
    let mut completion_error = None;

    let result = 'agent_run: {
        loop {
            tokio::select! {
                biased;
                _ = sleep(transcript.publish_delay()), if transcript.has_unpublished() => {
                    transcript.publish_if_needed(true);
                }
                update = finished.next() => {
                    match update {
                        Some(result) => {
                            match RuntimeClient::decode_run_finished_update(result) {
                                Ok(true) => {
                                    let text = if final_text.is_empty() {
                                        streamed_text
                                    } else {
                                        final_text
                                    };
                                    break 'agent_run AgentProviderResult::Cancelled { text };
                                }
                                Ok(false) => {}
                                Err(error) => {
                                    break 'agent_run AgentProviderResult::Failed {
                                        text: if final_text.is_empty() {
                                            streamed_text
                                        } else {
                                            final_text
                                        },
                                        error,
                                    };
                                }
                            }
                        }
                        None => {}
                    }
                }
                item = stream.next() => {
                    match item {
                        Some(Ok(rig::agent::MultiTurnStreamItem::FinalResponse(response))) => {
                            final_text = response.output().to_string();
                            completion_error = incomplete_completion_error(
                                response
                                    .completion_calls
                                    .last()
                                    .and_then(|call| call.finish_reason.as_ref()),
                            );
                        }
                        Some(Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(
                            StreamedAssistantContent::Text(text),
                        ))) => {
                            streamed_text.push_str(&text.text);
                            transcript.push_text(&text);
                        }
                        Some(Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(
                            StreamedAssistantContent::ReasoningDelta { id, reasoning, .. },
                        ))) => {
                            transcript.push_reasoning(&id, &reasoning);
                        }
                        Some(Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(
                            StreamedAssistantContent::Reasoning { reasoning, id },
                        ))) => {
                            transcript.complete_reasoning(&id, &reasoning);
                        }
                        Some(Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(
                            StreamedAssistantContent::ToolCall { tool_call, internal_call_id },
                        ))) => {
                            transcript.push_tool_call(
                                Some(internal_call_id.to_string()),
                                tool_call.wire_call_id().to_string(),
                                tool_call.function.name,
                                tool_call.function.arguments,
                            );
                        }
                        Some(Ok(rig::agent::MultiTurnStreamItem::ToolExecutionCommitted { .. })) => {
                            if let Err(error) = transcript.begin_next_turn_if_streamed().await {
                                break 'agent_run transcript_error(error, &final_text, &streamed_text);
                            }
                        }
                        Some(Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(
                            StreamedAssistantContent::ToolCallDelta { .. }
                            | StreamedAssistantContent::Final(_)
                            | StreamedAssistantContent::Unknown(_),
                        )))
                        | Some(Ok(rig::agent::MultiTurnStreamItem::ModelTurnRetried { .. }))
                        | Some(Ok(rig::agent::MultiTurnStreamItem::StreamUserItem(_)))
                        | Some(Ok(rig::agent::MultiTurnStreamItem::CompletionCall(_))) => {}
                        Some(Err(error)) => {
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
                        None => {
                            if let Some(error) = completion_error {
                                break 'agent_run AgentProviderResult::Failed {
                                    text: String::new(),
                                    error,
                                };
                            }
                            if let Err(error) = transcript.finalize_turn().await {
                                break 'agent_run transcript_error(
                                    error,
                                    &final_text,
                                    &streamed_text,
                                );
                            }
                            if final_text.is_empty() {
                                final_text = streamed_text;
                            }
                            break 'agent_run AgentProviderResult::Completed { text: final_text };
                        }
                    }
                }
            }
        }
    };

    session_shutdown.finish().await;
    result
}

const TRANSCRIPT_FLUSH_INTERVAL: Duration = Duration::from_millis(500);

#[cfg(test)]
#[path = "reasoning_integration_tests.rs"]
mod reasoning_integration_tests;

fn transcript_error(
    error: anyhow::Error,
    final_text: &str,
    streamed_text: &str,
) -> AgentProviderResult {
    let text = if final_text.is_empty() {
        streamed_text.to_string()
    } else {
        final_text.to_string()
    };
    match classify_provider_error(&error) {
        ProviderErrorDisposition::Superseded => AgentProviderResult::Superseded { error },
        ProviderErrorDisposition::Cancelled => AgentProviderResult::Cancelled { text },
        ProviderErrorDisposition::Failed => AgentProviderResult::Failed { text, error },
    }
}

struct TranscriptSink {
    runtime: RuntimeClient,
    live: Arc<LiveCompletionHub>,
    run_id: String,
    claim_id: String,
    thread_id: String,
    run_started_at: u64,
    stream_id: String,
    attempt_seq: u64,
    parts: LiveAssistantParts,
    provider_metadata: HashMap<String, serde_json::Value>,
    last_publish: Instant,
    unpublished: usize,
    streamed: bool,
    persist_reasoning_replay: Arc<AtomicBool>,
}

impl TranscriptSink {
    async fn start(
        runtime: RuntimeClient,
        live: Arc<LiveCompletionHub>,
        run_id: String,
        claim_id: String,
        thread_id: String,
        run_started_at: u64,
        persist_reasoning_replay: Arc<AtomicBool>,
    ) -> anyhow::Result<Self> {
        runtime
            .register_completion_attempt(&run_id, &claim_id, 1)
            .await?;
        Ok(Self {
            stream_id: format!("agent:{run_id}:{claim_id}:1"),
            runtime,
            live,
            run_id,
            claim_id,
            thread_id,
            run_started_at,
            attempt_seq: 1,
            parts: LiveAssistantParts::default(),
            provider_metadata: HashMap::new(),
            last_publish: Instant::now(),
            unpublished: 0,
            streamed: false,
            persist_reasoning_replay,
        })
    }

    fn push_text(&mut self, text: &rig::message::Text) {
        let id = contiguous_text_id(&self.parts.parts, &self.stream_id);
        let turn_id = Some(self.stream_id.clone());
        if let Some(params) = &text.additional_params {
            self.provider_metadata
                .insert(format!("text:{id}"), params.clone().into_value());
        }
        self.apply_text_delta("text", id, &text.text, turn_id);
        self.publish_if_needed(false);
    }

    fn push_reasoning(&mut self, id: &str, text: &str) {
        let part_id = format!("{}:{id}", self.stream_id);
        let turn_id = Some(self.stream_id.clone());
        self.apply_text_delta("reasoning", part_id, text, turn_id);
        self.publish_if_needed(false);
    }

    fn complete_reasoning(&mut self, correlator: &str, reasoning: &rig::message::Reasoning) {
        self.streamed = true;
        self.unpublished += 1;
        apply_completed_reasoning(
            &mut self.parts,
            &mut self.provider_metadata,
            &self.stream_id,
            correlator,
            reasoning,
        );
        self.publish_if_needed(true);
    }

    fn push_tool_call(
        &mut self,
        part_id: Option<String>,
        call_id: String,
        name: String,
        input: serde_json::Value,
    ) {
        let turn_id = Some(self.stream_id.clone());
        self.apply_tool_call(part_id, call_id, name, input, turn_id);
        self.publish_if_needed(true);
    }

    fn reset_parts(&mut self) {
        self.parts.clear();
        self.provider_metadata.clear();
        self.unpublished = 0;
        self.streamed = false;
    }

    async fn finalize_turn(&mut self) -> anyhow::Result<()> {
        self.publish_if_needed(true);
        self.runtime
            .finalize_completion_call(
                &self.run_id,
                &self.claim_id,
                self.attempt_seq,
                &self.stream_id,
                self.items_json(),
            )
            .await?;
        self.streamed = false;
        Ok(())
    }

    async fn begin_next_turn(&mut self) -> anyhow::Result<()> {
        self.finalize_turn().await?;
        self.reset_parts();
        self.attempt_seq += 1;
        self.stream_id = format!(
            "agent:{}:{}:{}",
            self.run_id, self.claim_id, self.attempt_seq
        );
        self.runtime
            .register_completion_attempt(&self.run_id, &self.claim_id, self.attempt_seq)
            .await
    }

    async fn begin_next_turn_if_streamed(&mut self) -> anyhow::Result<()> {
        if !self.streamed {
            return Ok(());
        }
        self.begin_next_turn().await
    }

    fn items_json(&self) -> Vec<serde_json::Value> {
        durable_items_json(
            &self.parts.parts,
            &self.provider_metadata,
            self.persist_reasoning_replay.load(Ordering::Acquire),
        )
    }

    fn has_unpublished(&self) -> bool {
        self.unpublished > 0
    }

    fn publish_delay(&self) -> Duration {
        TRANSCRIPT_FLUSH_INTERVAL.saturating_sub(self.last_publish.elapsed())
    }

    fn publish_if_needed(&mut self, force: bool) {
        if self.unpublished == 0 {
            return;
        }
        if !force
            && self.unpublished < 24
            && self.last_publish.elapsed() < TRANSCRIPT_FLUSH_INTERVAL
        {
            return;
        }
        self.publish();
    }

    fn publish(&mut self) {
        self.unpublished = 0;
        self.last_publish = Instant::now();
        self.live.publish(LiveCompletionOverlay {
            thread_id: self.thread_id.clone(),
            run_id: self.run_id.clone(),
            run_status: "running".to_string(),
            stream_id: Some(self.stream_id.clone()),
            text: join_assistant_text_parts(&self.parts.parts),
            parts: visible_live_parts(&self.parts.parts),
            run_started_at: self.run_started_at,
        });
    }

    fn apply_text_delta(
        &mut self,
        event_type: &str,
        id: String,
        delta: &str,
        turn_id: Option<String>,
    ) {
        self.streamed = true;
        self.unpublished += 1;
        self.parts
            .apply_text_delta(event_type, id, delta, turn_id, now_ms());
    }

    fn apply_tool_call(
        &mut self,
        part_id: Option<String>,
        call_id: String,
        name: String,
        input: serde_json::Value,
        turn_id: Option<String>,
    ) {
        self.streamed = true;
        self.unpublished += 1;
        self.parts
            .apply_tool_call(part_id, call_id, name, input, turn_id, now_ms());
    }
}

impl Drop for TranscriptSink {
    fn drop(&mut self) {
        self.publish_if_needed(true);
        self.live.clear(&self.thread_id);
    }
}

fn visible_live_parts(parts: &[LiveAssistantPart]) -> Vec<LiveAssistantPart> {
    parts
        .iter()
        .filter(|part| {
            !matches!(part, LiveAssistantPart::Reasoning { text, .. } if text.trim().is_empty())
        })
        .cloned()
        .collect()
}

fn durable_items_json(
    parts: &[LiveAssistantPart],
    provider_metadata: &HashMap<String, serde_json::Value>,
    persist_reasoning_replay: bool,
) -> Vec<serde_json::Value> {
    parts
        .iter()
        .map(|part| {
            let key = match part {
                LiveAssistantPart::Text { id, .. } => format!("text:{id}"),
                LiveAssistantPart::Reasoning { id, .. } => format!("reasoning:{id}"),
                LiveAssistantPart::ToolCall {
                    part_id, call_id, ..
                } => part_id.clone().unwrap_or_else(|| call_id.clone()),
            };
            let metadata = match part {
                LiveAssistantPart::Reasoning { .. } if !persist_reasoning_replay => None,
                _ => provider_metadata.get(&key),
            };
            merge_provider_metadata(part, metadata)
        })
        .collect()
}

fn contiguous_text_id(parts: &[LiveAssistantPart], stream_id: &str) -> String {
    match parts.last() {
        Some(LiveAssistantPart::Text { id, .. }) => id.clone(),
        _ => format!("{stream_id}:text:{}", parts.len()),
    }
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
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use rig::completion::FinishReason;

    use super::{
        ProviderErrorDisposition, RUN_NO_LONGER_ACTIVE, classify_provider_error,
        contiguous_text_id, durable_items_json, incomplete_completion_error, visible_live_parts,
    };
    use crate::live::LiveAssistantPart;

    #[test]
    fn live_projection_omits_empty_reasoning_without_removing_durable_state() {
        let parts = vec![
            LiveAssistantPart::Reasoning {
                id: "empty".into(),
                text: " \n".into(),
                started_at: None,
                completed_at: None,
                turn_id: None,
            },
            LiveAssistantPart::Reasoning {
                id: "visible".into(),
                text: "plan".into(),
                started_at: None,
                completed_at: None,
                turn_id: None,
            },
        ];
        let metadata = HashMap::from([("reasoning:empty".into(), reasoning_envelope())]);
        let live = visible_live_parts(&parts);
        assert_eq!(live.len(), 1);
        assert!(matches!(&live[0], LiveAssistantPart::Reasoning { id, .. } if id == "visible"));
        let durable = durable_items_json(&parts, &metadata, true);
        assert_eq!(durable.len(), 2);
        assert_eq!(durable[0]["providerMetadata"], reasoning_envelope());
    }

    #[test]
    fn text_after_reasoning_or_tools_starts_a_new_transcript_part() {
        let mut parts = vec![LiveAssistantPart::Text {
            id: "stream:text:0".into(),
            text: "Before".into(),
            started_at: None,
            completed_at: None,
            turn_id: Some("stream".into()),
        }];
        assert_eq!(contiguous_text_id(&parts, "stream"), "stream:text:0");
        parts.push(LiveAssistantPart::Reasoning {
            id: "stream:reasoning".into(),
            text: "".into(),
            started_at: None,
            completed_at: None,
            turn_id: Some("stream".into()),
        });
        assert_eq!(contiguous_text_id(&parts, "stream"), "stream:text:2");
        parts.push(LiveAssistantPart::ToolCall {
            part_id: None,
            call_id: "call".into(),
            name: "read".into(),
            input: serde_json::json!({}),
            started_at: None,
            completed_at: None,
            turn_id: Some("stream".into()),
        });
        assert_eq!(contiguous_text_id(&parts, "stream"), "stream:text:3");
    }

    #[test]
    fn classifies_superseded_completion_without_treating_it_as_failure() {
        let error =
            anyhow::anyhow!("completion provider failed: SPROCKET_COMPLETION_STREAM_SUPERSEDED");

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
    fn rejects_output_truncated_at_the_token_limit() {
        let error = incomplete_completion_error(Some(&FinishReason::Length))
            .expect("length must be treated as incomplete");

        assert!(error.to_string().contains("output token limit"));
        assert!(incomplete_completion_error(Some(&FinishReason::Stop)).is_none());
    }

    fn reasoning_envelope() -> serde_json::Value {
        serde_json::json!({
            "openai": {
                "itemId": "rs_1",
                "reasoningEncryptedContent": "envelope"
            }
        })
    }

    #[test]
    fn items_json_omits_reasoning_metadata_after_compaction_keeps_visible_text() {
        let persist_reasoning_replay = Arc::new(AtomicBool::new(true));
        let mut parts = vec![LiveAssistantPart::Reasoning {
            id: "stream:r1".into(),
            text: "visible plan".into(),
            started_at: None,
            completed_at: None,
            turn_id: Some("stream".into()),
        }];
        let mut provider_metadata =
            HashMap::from([("reasoning:stream:r1".to_string(), reasoning_envelope())]);
        parts.push(LiveAssistantPart::Text {
            id: "stream:text:1".into(),
            text: "hello".into(),
            started_at: None,
            completed_at: None,
            turn_id: Some("stream".into()),
        });
        assert_eq!(contiguous_text_id(&parts, "stream"), "stream:text:1");
        parts.push(LiveAssistantPart::Reasoning {
            id: "stream:r2".into(),
            text: "".into(),
            started_at: None,
            completed_at: None,
            turn_id: Some("stream".into()),
        });
        parts.push(LiveAssistantPart::Text {
            id: "stream:text:3".into(),
            text: " after".into(),
            started_at: None,
            completed_at: None,
            turn_id: Some("stream".into()),
        });
        assert_eq!(contiguous_text_id(&parts, "stream"), "stream:text:3");
        provider_metadata.insert("reasoning:stream:r2".to_string(), reasoning_envelope());

        let before = durable_items_json(
            &parts,
            &provider_metadata,
            persist_reasoning_replay.load(Ordering::Acquire),
        );
        assert_eq!(before[0]["text"], "visible plan");
        assert_eq!(before[0]["providerMetadata"], reasoning_envelope());
        assert_eq!(before[1]["text"], "hello");
        assert!(before[1].get("providerMetadata").is_none());
        assert_eq!(before[2]["providerMetadata"], reasoning_envelope());

        persist_reasoning_replay.store(false, Ordering::Release);
        let after = durable_items_json(
            &parts,
            &provider_metadata,
            persist_reasoning_replay.load(Ordering::Acquire),
        );
        assert_eq!(after[0]["type"], "reasoning");
        assert_eq!(after[0]["text"], "visible plan");
        assert!(after[0].get("providerMetadata").is_none());
        assert_eq!(after[1]["text"], "hello");
        assert_eq!(after[2]["text"], "");
        assert!(after[2].get("providerMetadata").is_none());
        assert_eq!(after[3]["text"], " after");
        assert_eq!(
            provider_metadata.get("reasoning:stream:r1"),
            Some(&reasoning_envelope()),
            "native in-process metadata stays after durable omit"
        );
        match &parts[0] {
            LiveAssistantPart::Reasoning { text, .. } => assert_eq!(text, "visible plan"),
            other => panic!("expected live reasoning text, got {other:?}"),
        }
    }
}
