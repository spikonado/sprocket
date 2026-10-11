use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::anyhow;
use futures::StreamExt;
use rig::DynModel;
use rig::agent::AgentBuilder;
use rig::completion::{FinishReason, Message};
use rig::message::AssistantContent;
use rig::operation::Completion;
use rig::providers::openai;
use rig::streaming::{Item, StreamEvent};
use sprocket_workspace::{CommandSessionManager, WorkspaceSkill};
use tokio::time::sleep;

use crate::chatgpt::ChatGptClient;
use crate::context_handoff::{
    ContextHandoffHook, HANDOFF_PROMPT, HANDOFF_SUBMITTED, context_summary_text,
};
use crate::convex::RuntimeClient;
use crate::gateway::GatewayClient;
use crate::hooks::{AgentPromptHook, ToolCallTracker};
use crate::live::{
    LiveAssistantPart, LiveAssistantParts, LiveCompletionHub, LiveCompletionOverlay,
    join_assistant_text_parts, now_ms,
};
use crate::openai::{developer_message, stateless_responses_model};
use crate::reasoning::{apply_completed_reasoning, merge_provider_metadata};
use crate::tools::agent_tools;
use crate::transcript::without_reasoning_traces;
use crate::types::{
    CompletionProvider, ContextBudget, ProviderHandoff, RunContextResponse, gateway_api_v1_url,
};

const AGENT_MAX_TURNS: usize = 1_000;
const MAX_INVALID_TOOL_CALL_RETRIES: usize = 3;

/// Must match `RUN_CANCELLED_BY_USER` in `apps/web/convex/lib/agentErrors.ts`.
const RUN_CANCELLED_BY_USER: &str = "Run is cancelled.";
/// Must match `RUN_NO_LONGER_ACTIVE` in `apps/web/convex/lib/agentErrors.ts`.
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
    completion_provider: CompletionProvider,
    gateway_url: String,
    model: String,
    chatgpt_client: Option<ChatGptClient>,
    provider_handoff: Option<ProviderHandoff>,
}

pub(crate) struct AgentProviderRequest {
    pub(crate) allow_interaction: bool,
    /// The run's thread is a child: question tools stay available, payment
    /// tools disappear, delegation tools stay.
    pub(crate) is_child: bool,
    pub(crate) cancellation: sprocket_workspace::WorkspaceCancellation,
    pub(crate) command_sessions: CommandSessionManager,
    pub(crate) run_id: String,
    pub(crate) claim_id: String,
    pub(crate) user_id: String,
    pub(crate) thread_id: String,
    pub(crate) run_started_at: u64,
    pub(crate) live: Arc<LiveCompletionHub>,
    pub(crate) prompt: Message,
    pub(crate) base_instructions: String,
    pub(crate) handoff_base_instructions: Option<String>,
    pub(crate) initial_context: Vec<Message>,
    pub(crate) prior_history: Vec<Message>,
    pub(crate) workspace_root: PathBuf,
    pub(crate) skills: Arc<[WorkspaceSkill]>,
    pub(crate) reasoning_effort: String,
    pub(crate) fast_mode: bool,
    pub(crate) context_budget: ContextBudget,
    pub(crate) supports_images: bool,
    pub(crate) transcript_dir: PathBuf,
    pub(crate) artifact_bindings: crate::artifact_bindings::ArtifactBindings,
    pub(crate) context_tokens: u64,
    pub(crate) defer_prompt_for_context_handoff: bool,
    /// The previous provider could not write a handoff. Continue without reasoning replay.
    pub(crate) omit_prior_reasoning: bool,
    pub(crate) gateway_url: String,
    pub(crate) subagent_launcher: Option<crate::subagents::SharedSubagentLauncher>,
    pub(crate) transcript_store: Option<Arc<crate::TranscriptStore>>,
}

pub(crate) enum AgentProviderResult {
    Completed { text: String },
    Cancelled { text: String },
    Superseded { error: anyhow::Error },
    Failed { text: String, error: anyhow::Error },
}

impl AgentProvider {
    pub(crate) fn default_for_run(
        context: &RunContextResponse,
        gateway_url: &str,
        chatgpt_client: Option<ChatGptClient>,
    ) -> anyhow::Result<Self> {
        let chatgpt_client = if context.run.completion_provider == CompletionProvider::Chatgpt
            || context
                .provider_handoff
                .as_ref()
                .is_some_and(|handoff| handoff.completion_provider == CompletionProvider::Chatgpt)
        {
            Some(chatgpt_client.ok_or_else(|| {
                anyhow!("ChatGPT runs require the local ChatGPT credential service.")
            })?)
        } else {
            None
        };
        Ok(Self {
            completion_provider: context.run.completion_provider,
            gateway_url: gateway_url.to_string(),
            model: context.run.selected_model.clone(),
            chatgpt_client,
            provider_handoff: context.provider_handoff.clone(),
        })
    }

    pub(crate) async fn run(
        mut self,
        runtime: RuntimeClient,
        mut request: AgentProviderRequest,
    ) -> AgentProviderResult {
        if self.completion_provider != CompletionProvider::Spikonado {
            request.fast_mode = false;
        }
        let handoff = self.provider_handoff.take();
        let source = handoff.as_ref().map(|handoff| Self {
            completion_provider: handoff.completion_provider,
            gateway_url: self.gateway_url.clone(),
            model: handoff.selected_model.clone(),
            chatgpt_client: self.chatgpt_client.clone(),
            provider_handoff: None,
        });
        let model_result = source
            .as_ref()
            .unwrap_or(&self)
            .completion_model(
                &runtime,
                &request.run_id,
                &request.claim_id,
                request
                    .handoff_base_instructions
                    .as_deref()
                    .unwrap_or(&request.base_instructions),
            )
            .await;
        drop(source);
        let (model, provider_switch) = match model_result {
            Ok(model) => (model, handoff.map(|handoff| (self, handoff))),
            Err(error) if handoff.is_some() => {
                eprintln!(
                    "sprocket-agent: provider switch context handoff failed ({error:#}); continuing on the selected provider without it"
                );
                request.omit_prior_reasoning = true;
                match self
                    .completion_model(
                        &runtime,
                        &request.run_id,
                        &request.claim_id,
                        &request.base_instructions,
                    )
                    .await
                {
                    Ok(model) => (model, None),
                    Err(error) => {
                        return AgentProviderResult::Failed {
                            text: String::new(),
                            error,
                        };
                    }
                }
            }
            Err(error) => {
                return AgentProviderResult::Failed {
                    text: String::new(),
                    error,
                };
            }
        };
        match run_with_completion_model(model, runtime, request, provider_switch).await {
            AgentProviderResult::Failed { text, error } => AgentProviderResult::Failed {
                text,
                error: crate::chatgpt::user_facing_error(error),
            },
            result => result,
        }
    }

    async fn completion_model(
        &self,
        runtime: &RuntimeClient,
        run_id: &str,
        claim_id: &str,
        base_instructions: &str,
    ) -> anyhow::Result<DynModel<Completion>> {
        match self.completion_provider {
            CompletionProvider::Spikonado => {
                let completion_client = GatewayClient::new(
                    gateway_api_v1_url(&self.gateway_url),
                    {
                        let runtime = runtime.clone();
                        let run_id = run_id.to_string();
                        let claim_id = claim_id.to_string();
                        move || {
                            let runtime = runtime.clone();
                            let run_id = run_id.clone();
                            let claim_id = claim_id.clone();
                            async move { runtime.issue_gateway_credential(&run_id, &claim_id).await }
                        }
                    },
                );
                Ok(completion_client.completion_model(&self.model, base_instructions))
            }
            CompletionProvider::Openai => {
                let credential = runtime.issue_openai_credential(run_id, claim_id).await?;
                let model = stateless_responses_model(
                    openai::OpenAIConfig::new(credential.api_key)
                        .with_instructions(base_instructions),
                    &self.model,
                );
                Ok(model)
            }
            CompletionProvider::Chatgpt => {
                let Some(completion_client) = &self.chatgpt_client else {
                    return Err(anyhow!(
                        "ChatGPT runs require the local ChatGPT credential service."
                    ));
                };
                Ok(completion_client.completion_model(&self.model, base_instructions))
            }
        }
    }
}

fn completion_parameters(
    reasoning_effort: &str,
    fast_mode: bool,
) -> anyhow::Result<serde_json::Value> {
    let reasoning_effort = serde_json::from_value::<openai::responses_api::ReasoningEffort>(
        serde_json::Value::String(reasoning_effort.to_string()),
    )
    .map_err(|error| anyhow!("invalid OpenAI Responses API reasoning effort: {error}"))?;
    Ok(openai::responses_api::AdditionalParameters {
        reasoning: Some(openai::responses_api::Reasoning::new().with_effort(reasoning_effort)),
        service_tier: fast_mode
            .then(|| openai::responses_api::OpenAIServiceTier::Other("fast".to_string())),
        ..Default::default()
    }
    .to_json())
}

pub(crate) async fn resume_context_handoff(
    agent: &mut rig::Agent,
    initial_context: &[Message],
    summary: &str,
    deferred_prompt: Option<Message>,
    save: impl std::future::Future<Output = anyhow::Result<bool>>,
    next_model: impl std::future::Future<Output = anyhow::Result<Option<DynModel<Completion>>>>,
) -> anyhow::Result<Option<(Vec<Message>, Message)>> {
    if !save.await? {
        return Ok(None);
    }
    if let Some(model) = next_model.await? {
        agent.set_model(model);
    }
    let mut history = initial_context.to_vec();
    let handoff = Message::user(context_summary_text(summary));
    let prompt = match deferred_prompt {
        Some(pending) => {
            history.push(handoff);
            pending
        }
        None => handoff,
    };
    Ok(Some((history, prompt)))
}

pub(crate) async fn resume_without_provider_handoff(
    agent: &mut rig::Agent,
    history: Vec<Message>,
    prompt: Message,
    record: impl std::future::Future<Output = anyhow::Result<bool>>,
    next_model: impl std::future::Future<Output = anyhow::Result<DynModel<Completion>>>,
) -> anyhow::Result<Option<(Vec<Message>, Message)>> {
    if !record.await? {
        return Ok(None);
    }
    agent.set_model(next_model.await?);
    Ok(Some((without_reasoning_traces(history), prompt)))
}

async fn run_with_completion_model(
    model: DynModel<Completion>,
    runtime: RuntimeClient,
    request: AgentProviderRequest,
    mut provider_switch: Option<(AgentProvider, ProviderHandoff)>,
) -> AgentProviderResult {
    let target_params = match completion_parameters(&request.reasoning_effort, request.fast_mode) {
        Ok(params) => params,
        Err(error) => {
            return AgentProviderResult::Failed {
                text: String::new(),
                error,
            };
        }
    };
    let mut additional_params = if let Some((_, handoff)) = &provider_switch {
        match completion_parameters(
            &handoff.reasoning_effort,
            handoff.fast_mode && handoff.completion_provider == CompletionProvider::Spikonado,
        ) {
            Ok(params) => params,
            Err(error) => {
                return AgentProviderResult::Failed {
                    text: String::new(),
                    error,
                };
            }
        }
    } else {
        target_params.clone()
    };
    let tool_call_tracker = ToolCallTracker::new(&request.run_id, &request.claim_id);
    let tools = agent_tools(
        runtime.clone(),
        request.run_id.clone(),
        request.claim_id.clone(),
        request.user_id.clone(),
        request.workspace_root.clone(),
        request.transcript_dir.clone(),
        request.gateway_url.clone(),
        request.transcript_store.clone(),
        request.artifact_bindings.clone(),
        request.supports_images,
        tool_call_tracker.clone(),
        request.skills.clone(),
        request.command_sessions.clone(),
        request.subagent_launcher.clone(),
    );
    let context_handoff_hook = ContextHandoffHook::new(
        request.context_budget.auto_handoff_token_limit,
        request.context_tokens,
        request.defer_prompt_for_context_handoff,
    );
    let agent = AgentBuilder::new(model)
        .tool(tools.apply_patch)
        .tool(tools.control_cmd)
        .tool(tools.exec_cmd)
        .tool(tools.read_skill)
        .tool(tools.scrape_url)
        .tool(tools.web_search)
        .tool(tools.poll_cmd)
        .tool(tools.add_artifact)
        .tool(tools.list_artifacts)
        .tool(tools.edit_artifact)
        .tool(tools.save_artifact)
        .tool(tools.delete_artifact)
        .tool(tools.parse_file)
        .tool(tools.spawn_subagent)
        .tool(tools.control_subagent)
        .tool(tools.poll_subagent)
        .tool(tools.list_subagents)
        .tool(tools.list_subagent_models)
        .tool(context_handoff_hook.tool());
    let agent = if request.allow_interaction || request.is_child {
        agent.tool(tools.ask_question).tool(tools.poll_question)
    } else {
        agent
    };
    let agent = if !request.is_child {
        let agent = agent
            .tool(tools.mandate_status)
            .tool(tools.mandate_list)
            .tool(tools.mandate_charge)
            .tool(tools.mandate_report);
        if request.allow_interaction {
            agent.tool(tools.mandate_setup)
        } else {
            agent
        }
    } else {
        agent
    };
    let mut agent = if request.supports_images {
        agent.tool(tools.screenshot_url)
    } else {
        agent
    }
    .build();

    eprintln!("sprocket-agent: built agent {}", request.run_id);
    eprintln!("sprocket-agent: prompting model {}", request.run_id);

    let mut transcript = match TranscriptSink::start(
        runtime.clone(),
        request.live.clone(),
        request.run_id.clone(),
        request.claim_id.clone(),
        request.thread_id.clone(),
        request.run_started_at,
        tool_call_tracker.clone(),
    )
    .await
    {
        Ok(sink) => sink,
        Err(error) => {
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

    let prompt_hook = AgentPromptHook::new(tool_call_tracker.clone());
    let initial_context: Arc<[Message]> = request.initial_context.into();
    let mut finished = match runtime.run_finished_subscription(&request.run_id).await {
        Ok(subscription) => subscription,
        Err(error) => {
            return AgentProviderResult::Failed {
                text: String::new(),
                error,
            };
        }
    };

    let mut history: Vec<_> = initial_context
        .iter()
        .cloned()
        .chain(request.prior_history)
        .collect();
    let mut prompt = request.prompt;
    let mut deferred_prompt = None;
    let mut before_prompt = false;
    let mut final_text = String::new();
    let mut final_response_received = false;
    let mut streamed_text = String::new();
    let mut observed_calls = 0;
    let mut completed_attempt = None;
    let mut handoff_processed_tokens = 0_u64;

    if request.omit_prior_reasoning {
        match runtime
            .omit_reasoning_replay(
                &request.run_id,
                &request.claim_id,
                request.defer_prompt_for_context_handoff,
            )
            .await
        {
            Ok(true) => {}
            Ok(false) => {
                return AgentProviderResult::Cancelled {
                    text: String::new(),
                };
            }
            Err(error) => return transcript_error(error, &final_text, &streamed_text),
        }
        history = without_reasoning_traces(history);
    }
    let mut provider_switch_resume = provider_switch
        .is_some()
        .then(|| (history.clone(), prompt.clone()));

    if provider_switch.is_some() {
        before_prompt = request.defer_prompt_for_context_handoff;
        if before_prompt {
            deferred_prompt = Some(prompt);
        } else {
            history.push(prompt);
        }
        prompt = developer_message(HANDOFF_PROMPT);
        context_handoff_hook.start_handoff();
    }

    macro_rules! continue_without_handoff {
        ($stream:ident, $generations:lifetime, $agent_run:lifetime, $reason:expr) => {{
            drop($stream);
            let (provider, _) = provider_switch.take().expect("provider-switch handoff");
            let (resume_history, resume_prompt) = provider_switch_resume
                .take()
                .expect("provider-switch conversation");
            eprintln!(
                "sprocket-agent: provider switch context handoff failed ({}); continuing on the selected provider without it",
                $reason
            );
            match resume_without_provider_handoff(
                &mut agent,
                resume_history,
                resume_prompt,
                runtime.omit_reasoning_replay(
                    &request.run_id,
                    &request.claim_id,
                    request.defer_prompt_for_context_handoff,
                ),
                provider.completion_model(
                    &runtime,
                    &request.run_id,
                    &request.claim_id,
                    &request.base_instructions,
                ),
            )
            .await
            {
                Ok(Some((next_history, next_prompt))) => {
                    history = next_history;
                    prompt = next_prompt;
                    deferred_prompt = None;
                    before_prompt = false;
                    additional_params = target_params.clone();
                    context_handoff_hook.restart();
                    handoff_processed_tokens = 0;
                    final_text.clear();
                    final_response_received = false;
                    streamed_text.clear();
                    continue $generations;
                }
                Ok(None) => {
                    break $agent_run AgentProviderResult::Cancelled {
                        text: streamed_text,
                    };
                }
                Err(error) => {
                    break $agent_run AgentProviderResult::Failed {
                        text: streamed_text,
                        error,
                    };
                }
            }
        }};
    }

    'agent_run: {
        'generations: loop {
            let mut stream = agent
                .prompt(prompt)
                .replace_additional_params(additional_params.clone())
                .history(history)
                .max_turns(AGENT_MAX_TURNS)
                .add_hook(context_handoff_hook.clone())
                .add_hook(prompt_hook.clone())
                .max_invalid_tool_call_retries(MAX_INVALID_TOOL_CALL_RETRIES)
                .stream();
            loop {
                tokio::select! {
                    biased;
                    _ = request.cancellation.cancelled() => {
                        break 'agent_run AgentProviderResult::Cancelled {
                            text: if final_text.is_empty() { streamed_text } else { final_text },
                        };
                    }
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
                            None => {
                                break 'agent_run AgentProviderResult::Failed {
                                    text: streamed_text,
                                    error: anyhow!("Run status subscription ended before the run completed."),
                                };
                            }
                        }
                    }
                    item = stream.next() => {
                        let calls = context_handoff_hook.completion_calls();
                        if calls != observed_calls {
                            if completed_attempt == Some(transcript.attempt_seq) {
                                if let Err(error) = transcript.advance_attempt().await {
                                    break 'agent_run transcript_error(error, &final_text, &streamed_text);
                                }
                            }
                            observed_calls = calls;
                        }
                        match item {
                            Some(Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(_)))
                            | Some(Ok(rig::agent::MultiTurnStreamItem::FinalResponse(_)))
                                if context_handoff_hook.is_writing() => {}
                            Some(Ok(rig::agent::MultiTurnStreamItem::CompletionCall(call))) => {
                                completed_attempt = Some(transcript.attempt_seq);
                                let tokens = context_handoff_hook.record_usage(call.usage);
                                if context_handoff_hook.is_writing() {
                                    handoff_processed_tokens =
                                        handoff_processed_tokens.saturating_add(tokens.unwrap_or(0));
                                } else {
                                    transcript.record_usage(tokens);
                                    transcript.record_completion(call.message_id.as_deref());
                                }
                                if let Some(error) = incomplete_completion_error(call.finish_reason.as_ref()) {
                                    if context_handoff_hook.is_writing() && provider_switch.is_some() {
                                        continue_without_handoff!(stream, 'generations, 'agent_run, format!("{error:#}"));
                                    } else {
                                        break 'agent_run AgentProviderResult::Failed {
                                            text: streamed_text,
                                            error: if context_handoff_hook.is_writing() {
                                                error.context("Context handoff failed: the model response was incomplete.")
                                            } else { error },
                                        };
                                    }
                                }
                            }
                            Some(Ok(rig::agent::MultiTurnStreamItem::FinalResponse(response))) => {
                                final_text = response.output().to_string();
                                final_response_received = true;
                            }
                            Some(Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(
                                Item::Event(StreamEvent::Text { part, text }),
                            ))) => {
                                transcript.push_streamed_text(part.index(), &text);
                                streamed_text = join_assistant_text_parts(&transcript.parts.parts);
                            }
                            Some(Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(
                                Item::Event(StreamEvent::Reasoning { part, text }),
                            ))) => {
                                transcript.push_reasoning(&format!("reasoning:{}", part.index()), &text);
                            }
                            Some(Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(
                                Item::Event(StreamEvent::End { part, content }),
                            ))) => {
                                match content {
                                    AssistantContent::Text(text) => {
                                        transcript.complete_text(part.index(), &text);
                                        streamed_text = join_assistant_text_parts(&transcript.parts.parts);
                                    }
                                    AssistantContent::Reasoning(reasoning) => {
                                        transcript.complete_reasoning(
                                            &format!("reasoning:{}", part.index()), &reasoning,
                                        );
                                    }
                                    AssistantContent::ToolCall(tool_call) => {
                                        transcript.push_tool_call(
                                            Some(format!("{}:tool:{}", transcript.stream_id, part.index())),
                                            tool_call,
                                        );
                                    }
                                    _ => {}
                                }
                            }
                            Some(Err(rig::completion::PromptError::Cancelled { reason, .. }))
                                if reason == HANDOFF_SUBMITTED => {
                                let Some(summary) = context_handoff_hook.take_summary() else {
                                    if provider_switch.is_some() {
                                        continue_without_handoff!(stream, 'generations, 'agent_run, "no valid document was submitted");
                                    }
                                    break 'agent_run AgentProviderResult::Failed {
                                        text: streamed_text,
                                        error: anyhow!("Context handoff failed: no valid document was submitted."),
                                    };
                                };
                                drop(stream);
                                let switching_provider = provider_switch.is_some();
                                let next_model = async {
                                    match provider_switch.take() {
                                        Some((provider, _)) => provider.completion_model(
                                            &runtime, &request.run_id, &request.claim_id,
                                            &request.base_instructions,
                                        ).await.map(Some),
                                        None => Ok(None),
                                    }
                                };
                                let save = runtime.save_context_handoff(
                                    &request.run_id, &request.claim_id, &summary,
                                    transcript.attempt_seq, before_prompt,
                                    handoff_processed_tokens,
                                );
                                match resume_context_handoff(
                                    &mut agent, &initial_context, &summary,
                                    deferred_prompt.take(), save, next_model,
                                ).await {
                                    Ok(Some((next_history, next_prompt))) => {
                                        history = next_history;
                                        prompt = next_prompt;
                                    }
                                    Ok(None) => break 'agent_run AgentProviderResult::Cancelled { text: streamed_text },
                                    Err(error) => break 'agent_run transcript_error(error, &final_text, &streamed_text),
                                }
                                if let Err(error) = transcript.advance_attempt().await {
                                    break 'agent_run transcript_error(error, &final_text, &streamed_text);
                                }
                                if switching_provider {
                                    additional_params = target_params.clone();
                                }
                                context_handoff_hook.restart();
                                handoff_processed_tokens = 0;
                                final_text.clear();
                                final_response_received = false;
                                streamed_text.clear();
                                continue 'generations;
                            }
                            Some(Ok(rig::agent::MultiTurnStreamItem::ToolExecutionCommitted { .. })) => {
                                if context_handoff_hook.is_writing() {
                                    if provider_switch.is_some() {
                                        continue_without_handoff!(stream, 'generations, 'agent_run, "no valid document was submitted");
                                    }
                                    break 'agent_run AgentProviderResult::Failed {
                                        text: streamed_text,
                                        error: anyhow!("Context handoff failed: no valid document was submitted."),
                                    };
                                }
                                if let Err(error) = transcript.begin_next_turn_if_streamed().await {
                                    break 'agent_run transcript_error(error, &final_text, &streamed_text);
                                }
                            }
                            Some(Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(_)))
                            | Some(Ok(rig::agent::MultiTurnStreamItem::ToolCall { .. }))
                            | Some(Ok(rig::agent::MultiTurnStreamItem::ModelTurnRetried { .. }))
                            | Some(Ok(rig::agent::MultiTurnStreamItem::StreamUserItem(_))) => {}
                            Some(Err(error)) => {
                                if let Some(handoff) = context_handoff_hook.take_request() {
                                    handoff_processed_tokens = 0;
                                    history = handoff.history;
                                    prompt = developer_message(HANDOFF_PROMPT);
                                    deferred_prompt = handoff.deferred_prompt;
                                    before_prompt = handoff.before_prompt;
                                    context_handoff_hook.start_handoff();
                                    continue 'generations;
                                }
                                if context_handoff_hook.is_writing() && provider_switch.is_some() {
                                    continue_without_handoff!(stream, 'generations, 'agent_run, format!("{error:#}"));
                                } else if context_handoff_hook.is_writing() {
                                    break 'agent_run AgentProviderResult::Failed {
                                        text: streamed_text,
                                        error: anyhow!(error).context("Context handoff failed. Retry to continue the conversation."),
                                    };
                                } else {
                                    let text = if final_text.is_empty() {
                                        streamed_text
                                    } else {
                                        final_text
                                    };
                                    let result = match classify_provider_error(&error) {
                                        ProviderErrorDisposition::Superseded => {
                                            AgentProviderResult::Superseded {
                                                error: anyhow!(error),
                                            }
                                        }
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
                            None => {
                                if context_handoff_hook.is_writing() {
                                    if provider_switch.is_some() {
                                        continue_without_handoff!(stream, 'generations, 'agent_run,
                                            "the handoff ended without submitting a document"
                                        );
                                    }
                                    break 'agent_run AgentProviderResult::Failed {
                                        text: streamed_text,
                                        error: anyhow!("Context handoff ended without submitting a document."),
                                    };
                                }
                                if !final_response_received {
                                    break 'agent_run AgentProviderResult::Failed {
                                        text: streamed_text,
                                        error: anyhow!("Agent stream ended without a final response."),
                                    };
                                }
                                if let Err(error) = transcript.finalize_turn().await {
                                    break 'agent_run transcript_error(
                                        error,
                                        &final_text,
                                        &streamed_text,
                                    );
                                }
                                break 'agent_run AgentProviderResult::Completed { text: final_text };
                            }
                        }
                    }
                }
            }
        }
    }
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
    usage_tokens: Option<u64>,
    tool_call_tracker: ToolCallTracker,
}

impl TranscriptSink {
    async fn start(
        runtime: RuntimeClient,
        live: Arc<LiveCompletionHub>,
        run_id: String,
        claim_id: String,
        thread_id: String,
        run_started_at: u64,
        tool_call_tracker: ToolCallTracker,
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
            usage_tokens: None,
            tool_call_tracker,
        })
    }

    fn push_streamed_text(&mut self, part: usize, text: &str) {
        let id = format!("{}:text:{part}", self.stream_id);
        let turn_id = Some(self.stream_id.clone());
        self.apply_text_delta("text", id, text, turn_id);
        self.publish_if_needed(false);
    }

    fn complete_text(&mut self, part: usize, text: &rig::message::Text) -> String {
        self.streamed = true;
        self.unpublished += 1;
        let previous = apply_completed_text(
            &mut self.parts,
            &mut self.provider_metadata,
            &self.stream_id,
            part,
            text,
        );
        self.publish_if_needed(true);
        previous
    }

    fn push_reasoning(&mut self, id: &str, text: &str) {
        let part_id = format!("{}:{id}", self.stream_id);
        let turn_id = Some(self.stream_id.clone());
        self.apply_text_delta("reasoning", part_id, text, turn_id);
        self.publish_if_needed(false);
    }

    fn complete_reasoning(
        &mut self,
        correlator: &str,
        reasoning: &rig::message::Sealed<rig::message::Reasoning>,
    ) {
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

    fn push_tool_call(&mut self, part_id: Option<String>, call: rig::message::ToolCall) {
        self.streamed = true;
        self.unpublished += 1;
        apply_completed_tool_call(
            &mut self.parts,
            &mut self.provider_metadata,
            &self.stream_id,
            part_id,
            call,
        );
        self.publish_if_needed(true);
    }

    fn reset_parts(&mut self) {
        self.parts.clear();
        self.provider_metadata.clear();
        self.unpublished = 0;
        self.streamed = false;
        self.usage_tokens = None;
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
                self.tool_call_tracker.completion_assignments(),
                self.usage_tokens,
            )
            .await?;
        self.streamed = false;
        Ok(())
    }

    async fn begin_next_turn(&mut self) -> anyhow::Result<()> {
        self.finalize_turn().await?;
        self.advance_attempt().await
    }

    async fn advance_attempt(&mut self) -> anyhow::Result<()> {
        self.reset_parts();
        self.attempt_seq += 1;
        self.stream_id = format!(
            "agent:{}:{}:{}",
            self.run_id, self.claim_id, self.attempt_seq
        );
        self.runtime
            .register_completion_attempt(&self.run_id, &self.claim_id, self.attempt_seq)
            .await?;
        self.tool_call_tracker
            .begin_attempt(self.attempt_seq, &self.stream_id);
        Ok(())
    }

    async fn begin_next_turn_if_streamed(&mut self) -> anyhow::Result<()> {
        if !self.streamed {
            return Ok(());
        }
        self.begin_next_turn().await
    }

    fn items_json(&self) -> Vec<serde_json::Value> {
        durable_items_json(&self.parts.parts, &self.provider_metadata)
    }

    fn has_unpublished(&self) -> bool {
        self.unpublished > 0
    }

    fn record_usage(&mut self, tokens: Option<u64>) {
        if tokens.is_some() {
            self.usage_tokens = tokens;
        }
    }

    fn record_completion(&mut self, message_id: Option<&str>) {
        preserve_text_message_id(&self.parts.parts, &mut self.provider_metadata, message_id);
        self.tool_call_tracker.record_parts(&self.parts.parts);
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
        let overlay = LiveCompletionOverlay {
            thread_id: self.thread_id.clone(),
            run_id: self.run_id.clone(),
            run_status: "running".to_string(),
            stream_id: self.stream_id.clone(),
            text: join_assistant_text_parts(&self.parts.parts),
            parts: visible_live_parts(&self.parts.parts),
            run_started_at: self.run_started_at,
        };
        self.live.publish(overlay);
        if let Some(output) = &self.runtime.output {
            output.notify_live_update();
        }
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
}

impl Drop for TranscriptSink {
    fn drop(&mut self) {
        self.publish_if_needed(true);
        self.live.clear(&self.thread_id);
        if let Some(output) = &self.runtime.output {
            output.notify_live_update();
        }
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
            merge_provider_metadata(part, provider_metadata.get(&key))
        })
        .collect()
}

fn apply_completed_text(
    parts: &mut LiveAssistantParts,
    provider_metadata: &mut HashMap<String, serde_json::Value>,
    stream_id: &str,
    part: usize,
    completed: &rig::message::Text,
) -> String {
    let id = format!("{stream_id}:text:{part}");
    let previous = parts.apply_completed_text(
        id.clone(),
        completed.text.clone(),
        Some(stream_id.to_string()),
        now_ms(),
    );
    if let Some(params) = &completed.additional_params {
        provider_metadata.insert(format!("text:{id}"), params.clone().into_value());
    }
    previous
}

fn apply_completed_tool_call(
    parts: &mut LiveAssistantParts,
    provider_metadata: &mut HashMap<String, serde_json::Value>,
    stream_id: &str,
    part_id: Option<String>,
    call: rig::message::ToolCall,
) {
    let call_id = call.id.wire().into_owned();
    let key = part_id.clone().unwrap_or_else(|| call_id.clone());
    let mut metadata = serde_json::Map::new();
    if let Some(item_id) = call.id.provider().and_then(|id| id.item_id.as_ref()) {
        metadata.insert("openai".into(), serde_json::json!({ "itemId": item_id }));
    }
    if let Some(signature) = call.signature {
        metadata.insert("signature".into(), signature.into());
    }
    metadata.insert(
        "toolCallAdditionalParams".into(),
        call.additional_params.unwrap_or(serde_json::Value::Null),
    );
    provider_metadata.insert(key, metadata.into());
    parts.apply_tool_call(
        part_id,
        call_id,
        call.function.name.into(),
        call.function.arguments,
        Some(stream_id.to_string()),
        now_ms(),
    );
}

fn preserve_text_message_id(
    parts: &[LiveAssistantPart],
    provider_metadata: &mut HashMap<String, serde_json::Value>,
    message_id: Option<&str>,
) {
    let Some(message_id) = message_id.filter(|id| !id.is_empty()) else {
        return;
    };
    for part in parts {
        if let LiveAssistantPart::Text { id, .. } = part {
            let metadata = provider_metadata
                .entry(format!("text:{id}"))
                .or_insert_with(|| serde_json::json!({}));
            let extras = metadata
                .as_object_mut()
                .expect("text metadata is a JSON object")
                .entry("openai_responses")
                .or_insert_with(|| serde_json::json!({}));
            if let Some(extras) = extras.as_object_mut() {
                extras
                    .entry("message_id")
                    .or_insert_with(|| message_id.into());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{
        ProviderErrorDisposition, RUN_NO_LONGER_ACTIVE, apply_completed_text,
        classify_provider_error, durable_items_json, visible_live_parts,
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
        let durable = durable_items_json(&parts, &metadata);
        assert_eq!(durable.len(), 2);
        assert_eq!(durable[0]["providerMetadata"], reasoning_envelope());
    }

    #[test]
    fn consecutive_text_parts_preserve_their_own_phase_and_authoritative_text() {
        let mut parts = super::LiveAssistantParts::default();
        let mut metadata = HashMap::new();
        parts.apply_text_delta(
            "text",
            "stream:text:0".into(),
            "partial",
            Some("stream".into()),
            1,
        );
        let commentary = rig::message::Text {
            text: "Working".into(),
            additional_params: Some(
                serde_json::from_value(serde_json::json!({"openai_responses": {"phase": "commentary", "message_id": "msg_commentary"}})).unwrap(),
            ),
        };
        assert_eq!(
            apply_completed_text(&mut parts, &mut metadata, "stream", 0, &commentary),
            "partial"
        );
        let answer = rig::message::Text {
            text: "Done".into(),
            additional_params: Some(
                serde_json::from_value(
                    serde_json::json!({"openai_responses": {"phase": "final_answer"}}),
                )
                .unwrap(),
            ),
        };
        assert_eq!(
            apply_completed_text(&mut parts, &mut metadata, "stream", 1, &answer),
            ""
        );
        super::preserve_text_message_id(&parts.parts, &mut metadata, Some("msg_answer"));
        let durable = durable_items_json(&parts.parts, &metadata);
        assert_eq!(durable.len(), 2);
        assert_eq!(durable[0]["text"], "Working");
        assert_eq!(
            durable[0]["providerMetadata"]["openai_responses"]["phase"],
            "commentary"
        );
        assert_eq!(durable[1]["text"], "Done");
        assert_eq!(
            durable[1]["providerMetadata"]["openai_responses"]["phase"],
            "final_answer"
        );

        let part = serde_json::from_value(serde_json::json!({
            "number": 0, "sourceKey": "completion", "kind": "completion", "runId": "run",
            "completion": {"streamId": "stream", "items": durable}
        }))
        .unwrap();
        let history =
            crate::types::deserialize_agent_history(crate::transcript::agent_history_from_parts(
                &crate::transcript::TranscriptState::new("user".into(), "thread".into()),
                &[part],
                None,
            ))
            .unwrap();
        let request = rig::providers::openai::responses_api::CompletionRequest::try_from(
            rig::providers::openai::responses_api::ResponsesRequestParams {
                model: "model".into(),
                request: rig::completion::CompletionRequest::new("continue").messages(history),
                system_instructions_placement: Default::default(),
                issuers: vec!["openai".into()],
            },
        )
        .unwrap();
        let replay = serde_json::to_value(request).unwrap();
        let input = replay["input"].as_array().unwrap();
        let commentary = input
            .iter()
            .find(|item| item["id"] == "msg_commentary")
            .unwrap();
        let answer = input
            .iter()
            .find(|item| item["id"] == "msg_answer")
            .unwrap();
        assert_eq!(commentary["phase"], "commentary");
        assert_eq!(answer["phase"], "final_answer");
    }

    #[test]
    fn persisted_tool_turn_reloads_native_identity_and_replay_metadata() {
        use rig::message::{AssistantContent, ToolCall, ToolFunction, UserContent};
        use serde_json::json;

        let mut call = ToolCall::from_dual_wire(
            "fc_1",
            "call_1",
            ToolFunction {
                name: "exec_cmd".try_into().unwrap(),
                arguments: json!({"cmd": "pwd"}),
            },
        );
        call.signature = Some("opaque-signature".into());
        call.additional_params = Some(json!({"native": {"futureField": "opaque"}}));
        let mut parts = super::LiveAssistantParts::default();
        let mut metadata = HashMap::new();
        super::apply_completed_tool_call(
            &mut parts,
            &mut metadata,
            "stream",
            Some("stream:tool:0".into()),
            call.clone(),
        );
        let durable = durable_items_json(&parts.parts, &metadata);
        assert_eq!(durable[0]["callId"], "call_1");

        let transcript = serde_json::from_value::<Vec<crate::transcript::TranscriptPart>>(json!([
            {
                "number": 0, "sourceKey": "completion", "kind": "completion", "runId": "run",
                "completion": {"streamId": "stream", "items": durable}
            },
            {
                "number": 1, "sourceKey": "tool", "kind": "tool", "runId": "run",
                "tool": {"callId": "call_1", "name": "exec_cmd", "status": "completed", "output": "/workspace"}
            }
        ])).unwrap();
        let history = crate::transcript::agent_history_from_parts(
            &crate::transcript::TranscriptState::new("user".into(), "thread".into()),
            &transcript,
            None,
        );
        let messages = crate::types::deserialize_agent_history(history).unwrap();
        let rig::message::Message::Assistant { content, .. } = &messages[0] else {
            panic!("expected assistant call");
        };
        assert_eq!(content, &[AssistantContent::ToolCall(call.clone())]);
        let rig::message::Message::User { content } = &messages[1] else {
            panic!("expected tool result");
        };
        let UserContent::ToolResult(result) = &content[0] else {
            panic!("expected tool result content");
        };
        assert_eq!(result.call, call.id);
        assert_eq!(result.name, call.function.name);
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

    fn reasoning_envelope() -> serde_json::Value {
        serde_json::json!({
            "openai": {
                "itemId": "rs_1",
                "reasoningEncryptedContent": "envelope"
            }
        })
    }
}
