use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::anyhow;
use futures::StreamExt;
use rig::DynModel;
use rig::agent::{
    AgentBuilder, AgentHook, HookContext, OutcomeAction, OutcomeEvent, StepEventKind,
};
use rig::completion::{Effort, FinishReason, GenerationOptions, Message, Reasoning};
use rig::message::AssistantContent;
use rig::operation::Completion;
use rig::providers::openai;
use rig::streaming::{Item, StreamEvent};
use sprocket_workspace::{CommandSessionManager, WorkspaceSkill};
use tokio::time::sleep;

use crate::chatgpt::ChatGptClient;
use crate::context_handoff::{
    ContextHandoffHook, HANDOFF_SUBMITTED, context_summary_text, handoff_prompt,
};
use crate::convex::RuntimeClient;
use crate::gateway::GatewayClient;
use crate::history::without_reasoning_traces;
use crate::hooks::{AgentPromptHook, ToolCallTracker};
use crate::now_ms;
use crate::openai::stateless_responses_model;
use crate::reasoning::{apply_completed_reasoning, merge_provider_metadata};
use crate::stream_recovery::{StreamRecovery, is_provider_failure};
use crate::tools::{agent_tools, max_yield_ms, working_directory_message};
use crate::types::{
    ChatGptCredentials, CompletionProvider, ContextBudget, ProviderHandoff, RunContextResponse,
    UsagePricing, gateway_api_v1_url,
};
use crate::usage::{ModelCallUsage, UsageSource};
use sprocket_transcript::{
    LiveAssistantPart, LiveAssistantParts, LiveCompletionHub, LiveCompletionOverlay,
    join_assistant_text_parts,
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
        Some(reason) => Some(anyhow!("The model stopped unexpectedly: {reason:?}")),
    }
}

pub(crate) struct AgentProvider {
    completion_provider: CompletionProvider,
    fallback_providers: VecDeque<CompletionProvider>,
    gateway_url: String,
    thread_id: String,
    model: String,
    model_vendor: String,
    chatgpt_client: Option<ChatGptClient>,
    chatgpt_credentials: Option<Arc<dyn ChatGptCredentials>>,
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
    pub(crate) live: Arc<LiveCompletionHub>,
    pub(crate) prompt: Message,
    pub(crate) base_instructions: String,
    pub(crate) handoff_base_instructions: Option<String>,
    pub(crate) initial_context: Vec<Message>,
    pub(crate) prior_history: Vec<Message>,
    pub(crate) workspace_root: PathBuf,
    pub(crate) cwd: PathBuf,
    pub(crate) skills: Arc<[WorkspaceSkill]>,
    pub(crate) reasoning_effort: String,
    pub(crate) fast_mode: bool,
    pub(crate) context_budget: ContextBudget,
    pub(crate) supports_images: bool,
    pub(crate) usage_pricing: UsagePricing,
    /// The provider-switch handoff model's pricing; the handoff runs on that model.
    pub(crate) handoff_usage_pricing: UsagePricing,
    pub(crate) transcript_dir: PathBuf,
    pub(crate) artifact_bindings: sprocket_workspace::artifact_bindings::ArtifactBindings,
    pub(crate) context_tokens: u64,
    pub(crate) defer_prompt_for_context_handoff: bool,
    /// The previous provider could not write a handoff. Continue without reasoning replay.
    pub(crate) omit_prior_reasoning: bool,
    pub(crate) gateway_url: String,
    pub(crate) subagent_launcher: Option<crate::subagents::SharedSubagentLauncher>,
    pub(crate) transcript_store: Option<Arc<sprocket_transcript::TranscriptStore>>,
    pub(crate) share_conversation_content: bool,
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
        model_vendor: &str,
        gateway_url: &str,
        chatgpt_client: Option<ChatGptClient>,
        chatgpt_credentials: Option<Arc<dyn ChatGptCredentials>>,
    ) -> Self {
        let completion_provider = context.run.completion_provider;
        let preferences = &context.provider_preferences;
        let restricted =
            context.run.parent_thread_id.is_some() && preferences.restrict_subagents_to_provider;
        let fallback_providers = if restricted {
            VecDeque::new()
        } else {
            preferences
                .enabled_providers
                .iter()
                .copied()
                .filter(|provider| {
                    *provider != completion_provider && provider.serves_vendor(model_vendor)
                })
                .collect()
        };
        Self {
            completion_provider,
            fallback_providers,
            gateway_url: gateway_url.to_string(),
            thread_id: context.run.thread_id.clone(),
            model: context.run.selected_model.clone(),
            model_vendor: model_vendor.to_string(),
            chatgpt_client,
            chatgpt_credentials,
            provider_handoff: context.provider_handoff.clone(),
        }
    }

    pub(crate) async fn run(
        mut self,
        runtime: RuntimeClient,
        mut request: AgentProviderRequest,
    ) -> AgentProviderResult {
        let handoff = self.provider_handoff.take();
        let source = handoff.as_ref().map(|handoff| Self {
            completion_provider: handoff.completion_provider,
            fallback_providers: VecDeque::new(),
            gateway_url: self.gateway_url.clone(),
            thread_id: self.thread_id.clone(),
            model: handoff.selected_model.clone(),
            model_vendor: String::new(),
            chatgpt_client: self.chatgpt_client.clone(),
            chatgpt_credentials: self.chatgpt_credentials.clone(),
            provider_handoff: None,
        });
        let source_model = match &source {
            Some(source) => Some(
                source
                    .completion_model(
                        &runtime,
                        &request.run_id,
                        &request.claim_id,
                        request
                            .handoff_base_instructions
                            .as_deref()
                            .unwrap_or(&request.base_instructions),
                    )
                    .await,
            ),
            None => None,
        };
        drop(source);
        let (model, provider_switch) = match source_model {
            Some(Ok(model)) => (model, handoff),
            source_model => {
                if let Some(Err(error)) = source_model {
                    eprintln!(
                        "sprocket-agent: provider switch context handoff failed ({error:#}); continuing on the selected provider without it"
                    );
                    request.omit_prior_reasoning = true;
                }
                let provider = self.completion_provider;
                match self
                    .start_model(
                        &runtime,
                        &request.run_id,
                        &request.claim_id,
                        &request.base_instructions,
                    )
                    .await
                {
                    Ok(model) => {
                        // Fallback already stripped replay in Convex; drop it locally too.
                        request.omit_prior_reasoning |= self.completion_provider != provider;
                        (model, None)
                    }
                    Err(error) => {
                        return AgentProviderResult::Failed {
                            text: String::new(),
                            error: crate::chatgpt::user_facing_error(error),
                        };
                    }
                }
            }
        };
        match run_with_completion_model(model, runtime, request, self, provider_switch).await {
            AgentProviderResult::Failed { text, error } => AgentProviderResult::Failed {
                text,
                error: crate::chatgpt::user_facing_error(error),
            },
            result => result,
        }
    }

    /// Builds the active provider's model, falling back past providers that cannot start.
    async fn start_model(
        &mut self,
        runtime: &RuntimeClient,
        run_id: &str,
        claim_id: &str,
        base_instructions: &str,
    ) -> anyhow::Result<DynModel<Completion>> {
        loop {
            let error = if self.completion_provider.serves_vendor(&self.model_vendor) {
                match self
                    .completion_model(runtime, run_id, claim_id, base_instructions)
                    .await
                {
                    Ok(model) => return Ok(model),
                    Err(error) => error,
                }
            } else {
                anyhow!(
                    "{} does not serve {}",
                    self.completion_provider.as_str(),
                    self.model
                )
            };
            if !self.fall_back(runtime, run_id, claim_id, &error).await? {
                return Err(error);
            }
        }
    }

    /// Moves the run to its next fallback provider. False when none remain.
    async fn fall_back(
        &mut self,
        runtime: &RuntimeClient,
        run_id: &str,
        claim_id: &str,
        error: &(impl std::fmt::Display + ?Sized),
    ) -> anyhow::Result<bool> {
        let Some(next) = self.fallback_providers.pop_front() else {
            return Ok(false);
        };
        eprintln!(
            "sprocket-agent: {} failed for run {run_id} ({error:#}); falling back to {}",
            self.completion_provider.as_str(),
            next.as_str()
        );
        if !runtime
            .fall_back_to_provider(run_id, claim_id, next)
            .await?
        {
            anyhow::bail!(RUN_NO_LONGER_ACTIVE);
        }
        self.completion_provider = next;
        Ok(true)
    }

    /// Rig fixes tool schemas when the agent is built, so one cap must cover
    /// every provider the run can fall back to.
    fn max_yield_ms(&self, cache_write_ttl: Option<&str>) -> u64 {
        self.fallback_providers.iter().fold(
            max_yield_ms(self.completion_provider, cache_write_ttl),
            |cap, &provider| cap.min(max_yield_ms(provider, cache_write_ttl)),
        )
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
                let completion_client = match (&self.chatgpt_client, &self.chatgpt_credentials) {
                    (Some(client), _) => client.clone(),
                    (None, Some(credentials)) => ChatGptClient::new(Arc::clone(credentials))?,
                    (None, None) => {
                        return Err(anyhow!(
                            "ChatGPT runs require the local ChatGPT credential service."
                        ));
                    }
                };
                Ok(completion_client.completion_model(
                    &self.model,
                    base_instructions,
                    &self.thread_id,
                ))
            }
        }
    }
}

fn completion_parameters(
    reasoning_effort: &str,
    fast_mode: bool,
) -> anyhow::Result<(GenerationOptions, serde_json::Value)> {
    let reasoning = if reasoning_effort == "none" {
        Reasoning::Off
    } else {
        serde_json::from_value::<Effort>(serde_json::Value::String(reasoning_effort.to_string()))
            .map(Reasoning::from)
            .map_err(|error| anyhow!("invalid reasoning effort: {error}"))?
    };
    // The gateway's "fast" tier is not Rig's portable Priority tier.
    let additional_params = if fast_mode {
        serde_json::json!({ "service_tier": "fast" })
    } else {
        serde_json::json!({})
    };
    Ok((
        GenerationOptions::default().reasoning(reasoning),
        additional_params,
    ))
}

#[derive(Clone, Default)]
struct CompletionOrigin(Arc<Mutex<Option<(usize, rig::message::Origin)>>>);

impl CompletionOrigin {
    fn take_for(&self, turn: usize) -> Option<rig::message::Origin> {
        let mut saved = self.0.lock().ok()?;
        if saved.as_ref()?.0 != turn {
            return None;
        }
        saved.take().map(|(_, origin)| origin)
    }
}

impl AgentHook for CompletionOrigin {
    fn observes(&self, kind: StepEventKind) -> bool {
        kind == StepEventKind::CompletionDispatch
    }

    async fn on_outcome(&self, _context: &HookContext, event: OutcomeEvent<'_>) -> OutcomeAction {
        if let Some(response) = event.completion()
            && let Ok(mut origin) = self.0.lock()
        {
            *origin = Some((event.turn, response.origin.clone()));
        }
        OutcomeAction::Proceed
    }
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
    mut target: AgentProvider,
    mut provider_switch: Option<ProviderHandoff>,
) -> AgentProviderResult {
    let legacy_origin = model
        .id()
        .map(|id| rig::message::Origin::new("openai.responses", model.name(), id));
    let (fast_params, standard_params) =
        match completion_parameters(&request.reasoning_effort, request.fast_mode).and_then(|fast| {
            Ok((
                fast,
                completion_parameters(&request.reasoning_effort, false)?,
            ))
        }) {
            Ok(params) => params,
            Err(error) => {
                return AgentProviderResult::Failed {
                    text: String::new(),
                    error,
                };
            }
        };
    let target_params = |target: &AgentProvider| {
        if target.completion_provider.serves_fast_mode() {
            fast_params.clone()
        } else {
            standard_params.clone()
        }
    };
    let mut additional_params = if let Some(handoff) = &provider_switch {
        match completion_parameters(
            &handoff.reasoning_effort,
            handoff.fast_mode && handoff.completion_provider.serves_fast_mode(),
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
        target_params(&target)
    };
    let tool_call_tracker = ToolCallTracker::new(&request.run_id, &request.claim_id);
    let offer_link_prs = !sprocket_workspace::github::settings().disabled;
    let tools = agent_tools(
        runtime.clone(),
        request.run_id.clone(),
        request.claim_id.clone(),
        request.user_id.clone(),
        request.workspace_root.clone(),
        request.cwd.clone(),
        request.transcript_dir.clone(),
        request.gateway_url.clone(),
        request.transcript_store.clone(),
        request.artifact_bindings.clone(),
        request.supports_images,
        tool_call_tracker.clone(),
        request.skills.clone(),
        request.command_sessions.clone(),
        request.subagent_launcher.clone(),
        target.max_yield_ms(request.usage_pricing.cache_write_ttl.as_deref()),
    );
    let cwd = tools.cwd.clone();
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
        .tool(tools.set_cwd)
        .tool(context_handoff_hook.tool());
    let agent = if offer_link_prs {
        agent.tool(tools.link_prs)
    } else {
        agent
    };
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
    let mut agent = agent.build();

    eprintln!("sprocket-agent: built agent {}", request.run_id);
    eprintln!("sprocket-agent: prompting model {}", request.run_id);

    let mut transcript = match TranscriptSink::start(
        runtime.clone(),
        request.live.clone(),
        request.run_id.clone(),
        request.claim_id.clone(),
        request.thread_id.clone(),
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
    let completion_origin = CompletionOrigin::default();
    let generation_tracker = crate::analytics::GenerationTracker::new(
        &request.run_id,
        &request.thread_id,
        request.share_conversation_content,
    );
    let initial_provider = target.completion_provider;
    let mut stream_recovery = StreamRecovery::default();
    let mut recovery_delay = Duration::ZERO;
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
        .chain([working_directory_message(&cwd.get())])
        .chain(request.prior_history)
        .collect();
    if let Some(origin) = &legacy_origin {
        crate::types::assign_unidentified_legacy_history_origin(&mut history, origin);
    }
    let mut prompt = request.prompt;
    let mut deferred_prompt = None;
    let mut before_prompt = false;
    let mut final_text = String::new();
    let mut final_response_received = false;
    let mut streamed_text = String::new();
    let mut observed_calls = 0;
    let mut completed_attempt = None;
    let mut handoff_calls: Vec<ModelCallUsage> = Vec::new();

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
        prompt = handoff_prompt();
        context_handoff_hook.start_handoff();
    }

    macro_rules! continue_without_handoff {
        ($stream:ident, $generations:lifetime, $agent_run:lifetime, $reason:expr) => {{
            drop($stream);
            provider_switch.take().expect("provider-switch handoff");
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
                target.start_model(
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
                    additional_params = target_params(&target);
                    context_handoff_hook.restart();
                    handoff_calls.clear();
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
            let mut pending_origin_turn = None;
            if let Ok(mut origin) = completion_origin.0.lock() {
                *origin = None;
            }
            let ready_at = tokio::time::Instant::now() + recovery_delay;
            recovery_delay = Duration::ZERO;
            let mut stream = agent
                .prompt(prompt)
                .options(additional_params.0.clone())
                .replace_additional_params(additional_params.1.clone())
                .history(history)
                .max_turns(AGENT_MAX_TURNS)
                .add_hook(completion_origin.clone())
                .add_hook(context_handoff_hook.clone())
                .add_hook(prompt_hook.clone())
                .add_hook(stream_recovery.clone())
                .add_hook(generation_tracker.clone())
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
                    item = async {
                        tokio::time::sleep_until(ready_at).await;
                        stream.next().await
                    } => {
                        if let Some(origin) = pending_origin_turn.and_then(|turn| completion_origin.take_for(turn))
                        {
                            transcript.record_origin(&origin);
                            pending_origin_turn = None;
                        }
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
                                let (provider, model, fast, pricing) = match provider_switch
                                    .as_ref()
                                    .filter(|_| context_handoff_hook.is_writing())
                                {
                                    Some(handoff) => (
                                        handoff.completion_provider,
                                        &handoff.selected_model,
                                        handoff.fast_mode,
                                        &request.handoff_usage_pricing,
                                    ),
                                    None => (
                                        target.completion_provider,
                                        &target.model,
                                        request.fast_mode,
                                        &request.usage_pricing,
                                    ),
                                };
                                let usage_source = UsageSource {
                                    provider,
                                    model: model.clone(),
                                    fast: fast && provider.serves_fast_mode(),
                                    pricing: pricing.clone(),
                                };
                                let call_usage = usage_source.call_usage(call.usage);
                                generation_tracker.capture(crate::analytics::GenerationCall {
                                    turn: call.call_index + 1,
                                    provider,
                                    model,
                                    usage: call.usage,
                                    finish_reason: call.finish_reason.as_ref(),
                                    context_handoff: context_handoff_hook.is_writing(),
                                    provider_fallback: provider != initial_provider,
                                });
                                let tokens = context_handoff_hook.record_usage(call.usage);
                                if context_handoff_hook.is_writing() {
                                    handoff_calls.extend(call_usage);
                                } else {
                                    transcript.record_usage(tokens, call_usage);
                                    transcript.parts.order_stream_parts(&transcript.stream_id);
                                    transcript.tool_call_tracker.record_parts(&transcript.parts.parts);
                                    pending_origin_turn = Some(call.call_index + 1);
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
                                Item::Event(StreamEvent::Start { part, kind: rig::streaming::PartKind::Reasoning, .. }),
                            ))) => {
                                transcript.push_reasoning(&format!("reasoning:{}", part.index()), "");
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
                                        Some(_) => target.start_model(
                                            &runtime, &request.run_id, &request.claim_id,
                                            &request.base_instructions,
                                        ).await.map(Some),
                                        None => Ok(None),
                                    }
                                };
                                let save = runtime.save_context_handoff(
                                    &request.run_id, &request.claim_id, &summary,
                                    transcript.attempt_seq, before_prompt,
                                    &handoff_calls,
                                );
                                let handoff_context: Vec<_> = initial_context
                                    .iter()
                                    .cloned()
                                    .chain([working_directory_message(&cwd.get())])
                                    .collect();
                                match resume_context_handoff(
                                    &mut agent, &handoff_context, &summary,
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
                                    additional_params = target_params(&target);
                                }
                                context_handoff_hook.restart();
                                handoff_calls.clear();
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
                                if let Err(error) = transcript.begin_next_turn_after_tools().await {
                                    break 'agent_run transcript_error(error, &final_text, &streamed_text);
                                }
                            }
                            Some(Ok(rig::agent::MultiTurnStreamItem::ToolCall { .. })) => {
                                // Rig emits this after the turn commits and before its tools run, so
                                // persisting here keeps the calls when the run stops mid-tool.
                                if !context_handoff_hook.is_writing()
                                    && let Err(error) = transcript.finalize_turn_if_streamed().await
                                {
                                    break 'agent_run transcript_error(error, &final_text, &streamed_text);
                                }
                            }
                            Some(Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(_)))
                            | Some(Ok(rig::agent::MultiTurnStreamItem::ToolResult { .. })) => {}
                            Some(Ok(rig::agent::MultiTurnStreamItem::ModelTurnRetried { .. })) => {
                                if let Err(error) = transcript.advance_attempt().await {
                                    break 'agent_run transcript_error(error, &final_text, &streamed_text);
                                }
                                transcript.live.clear(&request.thread_id);
                                if let Some(output) = &transcript.runtime.output {
                                    output.notify_live_update();
                                }
                                completed_attempt = None;
                                final_text.clear();
                                final_response_received = false;
                                streamed_text.clear();
                            }
                            Some(Ok(_)) => {}
                            Some(Err(error)) => {
                                if let Some(handoff) = context_handoff_hook.take_request() {
                                    handoff_calls.clear();
                                    history = handoff.history;
                                    prompt = handoff_prompt();
                                    deferred_prompt = handoff.deferred_prompt;
                                    before_prompt = handoff.before_prompt;
                                    context_handoff_hook.start_handoff();
                                    continue 'generations;
                                }
                                if let Some((next_history, next_prompt, delay)) = stream_recovery.resume(&error) {
                                    drop(stream);
                                    eprintln!("sprocket-agent: provider stream was interrupted; retrying the failed turn in {delay:?}");
                                    history = next_history;
                                    prompt = next_prompt;
                                    recovery_delay = delay;
                                    if let Err(error) = transcript.advance_attempt().await {
                                        break 'agent_run transcript_error(error, &final_text, &streamed_text);
                                    }
                                    transcript.live.clear(&request.thread_id);
                                    if let Some(output) = &transcript.runtime.output {
                                        output.notify_live_update();
                                    }
                                    final_text.clear();
                                    final_response_received = false;
                                    streamed_text.clear();
                                    continue 'generations;
                                }
                                // A provider-switch handoff writes on the previous provider.
                                if provider_switch.is_none()
                                    && !target.fallback_providers.is_empty()
                                    && is_provider_failure(&error)
                                    && classify_provider_error(&error) == ProviderErrorDisposition::Failed
                                    && let Some((next_history, next_prompt)) = stream_recovery.take_input()
                                {
                                    drop(stream);
                                    let next_model = async {
                                        target.fall_back(&runtime, &request.run_id, &request.claim_id, &error).await?;
                                        target.start_model(
                                            &runtime, &request.run_id, &request.claim_id,
                                            &request.base_instructions,
                                        ).await
                                    };
                                    match next_model.await {
                                        Ok(model) => agent.set_model(model),
                                        Err(error) => break 'agent_run transcript_error(error, &final_text, &streamed_text),
                                    }
                                    history = without_reasoning_traces(next_history);
                                    prompt = next_prompt;
                                    additional_params = target_params(&target);
                                    if let Err(error) = transcript.advance_attempt().await {
                                        break 'agent_run transcript_error(error, &final_text, &streamed_text);
                                    }
                                    transcript.live.clear(&request.thread_id);
                                    if let Some(output) = &transcript.runtime.output {
                                        output.notify_live_update();
                                    }
                                    final_text.clear();
                                    final_response_received = false;
                                    streamed_text.clear();
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
    stream_id: String,
    attempt_seq: u64,
    parts: LiveAssistantParts,
    provider_metadata: HashMap<String, serde_json::Value>,
    last_publish: Instant,
    unpublished: usize,
    streamed: bool,
    finalized: bool,
    usage_tokens: Option<u64>,
    call_usage: Option<ModelCallUsage>,
    tool_call_tracker: ToolCallTracker,
}

impl TranscriptSink {
    async fn start(
        runtime: RuntimeClient,
        live: Arc<LiveCompletionHub>,
        run_id: String,
        claim_id: String,
        thread_id: String,
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
            attempt_seq: 1,
            parts: LiveAssistantParts::default(),
            provider_metadata: HashMap::new(),
            last_publish: Instant::now(),
            unpublished: 0,
            streamed: false,
            finalized: false,
            usage_tokens: None,
            call_usage: None,
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
        self.finalized = false;
        self.usage_tokens = None;
        self.call_usage = None;
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
                self.call_usage.as_ref(),
            )
            .await?;
        self.streamed = false;
        self.finalized = true;
        Ok(())
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

    async fn finalize_turn_if_streamed(&mut self) -> anyhow::Result<()> {
        if self.streamed {
            self.finalize_turn().await?;
        }
        Ok(())
    }

    async fn begin_next_turn_after_tools(&mut self) -> anyhow::Result<()> {
        self.finalize_turn_if_streamed().await?;
        if self.finalized {
            self.advance_attempt().await?;
        }
        Ok(())
    }

    fn items_json(&self) -> Vec<serde_json::Value> {
        durable_items_json(&self.parts.parts, &self.provider_metadata)
    }

    fn has_unpublished(&self) -> bool {
        self.unpublished > 0
    }

    fn record_usage(&mut self, tokens: Option<u64>, call_usage: Option<ModelCallUsage>) {
        if tokens.is_some() {
            self.usage_tokens = tokens;
        }
        if call_usage.is_some() {
            self.call_usage = call_usage;
        }
    }

    fn record_origin(&mut self, origin: &rig::message::Origin) {
        apply_completion_origin(&self.parts.parts, &mut self.provider_metadata, origin);
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

fn apply_completion_origin(
    parts: &[LiveAssistantPart],
    provider_metadata: &mut HashMap<String, serde_json::Value>,
    origin: &rig::message::Origin,
) {
    for part in parts {
        let key = match part {
            LiveAssistantPart::Text { id, .. } => format!("text:{id}"),
            LiveAssistantPart::Reasoning { id, .. } => format!("reasoning:{id}"),
            LiveAssistantPart::ToolCall {
                part_id, call_id, ..
            } => part_id.clone().unwrap_or_else(|| call_id.clone()),
        };
        let metadata = provider_metadata
            .entry(key)
            .or_insert_with(|| serde_json::json!({}));
        metadata["origin"] = serde_json::to_value(origin).expect("origin always serializes");
    }
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
    let block = AssistantContent::Text(completed.clone());
    if let Some(native) = block.native_item() {
        let mut item = native.clone();
        if let Some(content) = item
            .get_mut("content")
            .and_then(serde_json::Value::as_array_mut)
        {
            for part in content {
                if let Some(part) = part.as_object_mut() {
                    part.remove("text");
                }
            }
        }
        provider_metadata.insert(
            format!("text:{id}"),
            serde_json::json!({ "rigNative": item }),
        );
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
    let block = AssistantContent::ToolCall(call.clone());
    if let Some(native) = block.native_item() {
        let mut item = native.clone();
        // Replay rebuilds canonical arguments, so only keep the model's
        // spelling when it differs; replaying other bytes breaks prompt caching.
        let canonical = call.function.arguments_value().to_string();
        if let Some(item) = item.as_object_mut()
            && item.get("arguments").and_then(serde_json::Value::as_str) == Some(&canonical)
        {
            item.remove("arguments");
        }
        provider_metadata.insert(key, serde_json::json!({ "rigNative": item }));
    } else {
        provider_metadata.remove(&key);
    }
    parts.apply_tool_call(
        part_id,
        call_id,
        call.function.name.into(),
        call.function.arguments.into(),
        Some(stream_id.to_string()),
        now_ms(),
    );
}

#[cfg(test)]
mod tests;
