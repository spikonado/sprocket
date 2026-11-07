mod transcript_sink;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
use sprocket_convex::{ConvexErrorCode, convex_error_code};
use sprocket_transcript::LiveCompletionHub;
use sprocket_workspace::{CommandSessionManager, WorkspaceSkill};
use tokio::time::sleep;

use self::transcript_sink::TranscriptSink;
use crate::chatgpt::ChatGptClient;
use crate::claude_code::{ClaudeCode, ResumePoint, resume_point};
use crate::context_handoff::{
    ContextHandoffHook, HANDOFF_SUBMITTED, context_summary_text, handoff_prompt,
};
use crate::convex::{ClaimStatus, ContextHandoffWrite, RuntimeClient};
use crate::gateway::GatewayClient;
use crate::history::without_reasoning_traces;
use crate::hooks::{AgentPromptHook, ToolCallTracker};
use crate::openai::stateless_responses_model;
use crate::request_compression::ZstdResponsesRequests;
use crate::stream_recovery::{StreamRecovery, is_provider_failure};
use crate::tools::{agent_tools, max_yield_ms};
use crate::types::{
    ChatGptCredentials, CompletionProvider, ContextBudget, ProviderHandoff, RunContextResponse,
    UsagePricing, gateway_api_v1_url,
};
use crate::usage::UsageSource;
use crate::workspace_context::{HiddenPrompt, WorkspaceContext};

const AGENT_MAX_TURNS: usize = 1_000;
const MAX_INVALID_TOOL_CALL_RETRIES: usize = 3;

#[derive(Debug, thiserror::Error)]
#[error("Run is no longer active.")]
struct RunNoLongerActive;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProviderErrorDisposition {
    Cancelled,
    Superseded,
    Failed,
}

fn classify_provider_error(error: &anyhow::Error) -> ProviderErrorDisposition {
    if error.is::<RunNoLongerActive>() {
        return ProviderErrorDisposition::Cancelled;
    }
    match convex_error_code(error) {
        Some(ConvexErrorCode::CompletionStreamSuperseded) => ProviderErrorDisposition::Superseded,
        Some(ConvexErrorCode::RunCancelled | ConvexErrorCode::RunNoLongerActive) => {
            ProviderErrorDisposition::Cancelled
        }
        _ => ProviderErrorDisposition::Failed,
    }
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

fn user_facing_error(error: anyhow::Error) -> anyhow::Error {
    crate::chatgpt::user_facing_error(crate::claude_code::user_facing_error(error))
}

/// A provider-switch handoff writes on the previous provider.
fn usage_source(
    target: &AgentProvider,
    fast_mode: bool,
    pricing: &UsagePricing,
    switch: Option<&ProviderSwitchHandoff>,
) -> UsageSource {
    let (provider, model, fast, pricing) = match switch {
        Some(switch) => (
            switch.handoff.completion_provider,
            &switch.handoff.selected_model,
            switch.handoff.fast_mode,
            &switch.usage_pricing,
        ),
        None => (
            target.completion_provider,
            &target.model,
            fast_mode,
            pricing,
        ),
    };
    UsageSource {
        provider,
        model: model.clone(),
        fast: fast && provider.fast_service_tier().is_some(),
        pricing: pricing.clone(),
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
    claude_code: ClaudeCode,
    claude_resume: Option<ResumePoint>,
    cwd: PathBuf,
}

#[derive(Default)]
pub(crate) enum ProviderSwitch {
    #[default]
    None,
    /// The previous provider writes a context handoff before the selected one continues.
    Handoff(ProviderSwitchHandoff),
    /// The selected provider continues without the previous provider's reasoning.
    WithoutHandoff,
}

pub(crate) struct ProviderSwitchHandoff {
    pub(crate) handoff: ProviderHandoff,
    pub(crate) base_instructions: String,
    pub(crate) usage_pricing: UsagePricing,
}

/// A provider-switch handoff in progress, with the conversation to resume
/// without it if it fails.
struct PendingProviderSwitch {
    switch: ProviderSwitchHandoff,
    history: Vec<Message>,
    prompt: Message,
}

pub(crate) struct AgentProviderRequest {
    pub(crate) allow_interaction: bool,
    pub(crate) is_child: bool,
    pub(crate) cancellation: sprocket_workspace::WorkspaceCancellation,
    pub(crate) command_sessions: CommandSessionManager,
    pub(crate) command_cursors: crate::tools::CommandCursors,
    pub(crate) run_id: String,
    pub(crate) claim_id: String,
    pub(crate) user_id: String,
    pub(crate) thread_id: String,
    pub(crate) live: Arc<LiveCompletionHub>,
    pub(crate) prompt: Message,
    pub(crate) base_instructions: String,
    pub(crate) workspace_context: WorkspaceContext,
    pub(crate) begin_prompts: Vec<HiddenPrompt>,
    pub(crate) prior_history: Vec<Message>,
    pub(crate) workspace_root: PathBuf,
    pub(crate) cwd: PathBuf,
    pub(crate) skills: Arc<[WorkspaceSkill]>,
    pub(crate) reasoning_effort: String,
    pub(crate) fast_mode: bool,
    pub(crate) context_budget: ContextBudget,
    pub(crate) supports_images: bool,
    pub(crate) usage_pricing: UsagePricing,
    pub(crate) transcript_dir: PathBuf,
    pub(crate) artifact_bindings: sprocket_workspace::artifact_bindings::ArtifactBindings,
    pub(crate) context_tokens: u64,
    pub(crate) defer_prompt_for_context_handoff: bool,
    pub(crate) provider_switch: ProviderSwitch,
    pub(crate) gateway_url: String,
    pub(crate) subagent_models: Arc<crate::catalog::SubagentModelChoices>,
    pub(crate) subagent_launcher: Option<crate::subagents::SharedSubagentLauncher>,
    pub(crate) transcript_store: Option<Arc<sprocket_transcript::TranscriptStore>>,
    pub(crate) share_conversation_content: bool,
}

pub(crate) enum AgentProviderResult {
    Completed,
    Cancelled,
    Superseded { error: anyhow::Error },
    Failed { error: anyhow::Error },
}

impl AgentProvider {
    pub(crate) fn default_for_run(
        context: &RunContextResponse,
        model_vendor: &str,
        gateway_url: &str,
        chatgpt_client: Option<ChatGptClient>,
        chatgpt_credentials: Option<Arc<dyn ChatGptCredentials>>,
        claude_code: ClaudeCode,
        cwd: PathBuf,
    ) -> Self {
        let completion_provider = context.run.completion_provider;
        let fallback_providers = context
            .provider_preferences
            .enabled_providers
            .iter()
            .copied()
            .filter(|provider| {
                *provider != completion_provider && provider.serves_vendor(model_vendor)
            })
            .collect();
        Self {
            completion_provider,
            fallback_providers,
            gateway_url: gateway_url.to_string(),
            thread_id: context.run.thread_id.clone(),
            model: context.run.selected_model.clone(),
            model_vendor: model_vendor.to_string(),
            chatgpt_client,
            chatgpt_credentials,
            claude_code,
            claude_resume: None,
            cwd,
        }
    }

    pub(crate) async fn run(
        mut self,
        runtime: RuntimeClient,
        mut request: AgentProviderRequest,
    ) -> AgentProviderResult {
        self.claude_resume = resume_point(&request.prior_history);
        let mut omit_prior_reasoning = false;
        let switch = match std::mem::take(&mut request.provider_switch) {
            ProviderSwitch::Handoff(switch) => {
                match self
                    .handoff_model(
                        &runtime,
                        &request.run_id,
                        &request.claim_id,
                        &request.base_instructions,
                        &switch,
                    )
                    .await
                {
                    Ok(model) => Some((model, switch)),
                    Err(error) => {
                        eprintln!(
                            "sprocket-agent: provider switch context handoff failed ({error:#}); continuing on the selected provider without it"
                        );
                        omit_prior_reasoning = true;
                        None
                    }
                }
            }
            ProviderSwitch::WithoutHandoff => {
                omit_prior_reasoning = true;
                None
            }
            ProviderSwitch::None => None,
        };
        let (model, switch) = match switch {
            Some((model, switch)) => (model, Some(switch)),
            None => {
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
                        omit_prior_reasoning |= self.completion_provider != provider;
                        (model, None)
                    }
                    Err(error) => {
                        return AgentProviderResult::Failed {
                            error: user_facing_error(error),
                        };
                    }
                }
            }
        };
        // Models started later join mid-run, after replies the resumed session didn't write.
        self.claude_resume = None;
        match run_with_completion_model(model, runtime, request, self, switch, omit_prior_reasoning)
            .await
        {
            AgentProviderResult::Failed { error } => AgentProviderResult::Failed {
                error: user_facing_error(error),
            },
            result => result,
        }
    }

    /// The handoff writes the prompt before the target model starts, so a
    /// target that cannot start (such as exhausted usage) skips the handoff.
    async fn handoff_model(
        &self,
        runtime: &RuntimeClient,
        run_id: &str,
        claim_id: &str,
        base_instructions: &str,
        switch: &ProviderSwitchHandoff,
    ) -> anyhow::Result<DynModel<Completion>> {
        let source = Self {
            completion_provider: switch.handoff.completion_provider,
            fallback_providers: VecDeque::new(),
            gateway_url: self.gateway_url.clone(),
            thread_id: self.thread_id.clone(),
            model: switch.handoff.selected_model.clone(),
            model_vendor: String::new(),
            chatgpt_client: self.chatgpt_client.clone(),
            chatgpt_credentials: self.chatgpt_credentials.clone(),
            claude_code: self.claude_code.clone(),
            claude_resume: self.claude_resume.clone(),
            cwd: self.cwd.clone(),
        };
        let model = source
            .completion_model(runtime, run_id, claim_id, &switch.base_instructions)
            .await?;
        if self.completion_provider.serves_vendor(&self.model_vendor) {
            self.completion_model(runtime, run_id, claim_id, base_instructions)
                .await?;
        }
        Ok(model)
    }

    async fn start_model(
        &mut self,
        runtime: &RuntimeClient,
        run_id: &str,
        claim_id: &str,
        base_instructions: &str,
    ) -> anyhow::Result<DynModel<Completion>> {
        let mut usage_limit = None;
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
                return Err(usage_limit.unwrap_or(error));
            }
            if usage_limit.is_none()
                && convex_error_code(&error) == Some(ConvexErrorCode::UsageLimitReached)
            {
                usage_limit = Some(error);
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
        if runtime
            .fall_back_to_provider(run_id, claim_id, next)
            .await?
            == ClaimStatus::Lost
        {
            return Err(RunNoLongerActive.into());
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
                let credential = runtime.issue_gateway_credential(run_id, claim_id).await?;
                let completion_client = GatewayClient::new(
                    gateway_api_v1_url(&self.gateway_url),
                    credential,
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
                        .with_instructions(base_instructions)
                        .connect(rig::rig_reqwest::shared().with_middleware(ZstdResponsesRequests)),
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
            CompletionProvider::Claude => {
                let credential = runtime.issue_claude_credential(run_id, claim_id).await?;
                self.claude_code
                    .completion_model(
                        credential.token,
                        &self.model,
                        base_instructions,
                        &self.cwd,
                        self.claude_resume.clone(),
                    )
                    .await
            }
        }
    }
}

fn generation_options(reasoning_effort: &str) -> anyhow::Result<GenerationOptions> {
    let reasoning = if reasoning_effort == "none" {
        Reasoning::Off
    } else {
        serde_json::from_value::<Effort>(serde_json::Value::String(reasoning_effort.to_string()))
            .map(Reasoning::from)
            .map_err(|error| anyhow!("invalid reasoning effort: {error}"))?
    };
    Ok(GenerationOptions::default().reasoning(reasoning))
}

// Tier names differ per provider, so they bypass Rig's portable tiers.
fn service_tier_params(provider: CompletionProvider, fast_mode: bool) -> serde_json::Value {
    match provider.fast_service_tier() {
        Some(tier) if fast_mode => serde_json::json!({ "service_tier": tier }),
        _ => serde_json::json!({}),
    }
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
    summary: &str,
    workspace_context: Vec<Message>,
    deferred_prompt: Option<Message>,
    save: impl std::future::Future<Output = anyhow::Result<ClaimStatus>>,
    next_model: impl std::future::Future<Output = anyhow::Result<Option<DynModel<Completion>>>>,
) -> anyhow::Result<Option<(Vec<Message>, Message)>> {
    if save.await? == ClaimStatus::Lost {
        return Ok(None);
    }
    if let Some(model) = next_model.await? {
        agent.set_model(model);
    }
    let mut history = vec![Message::user(context_summary_text(summary))];
    history.extend(workspace_context);
    let prompt = match deferred_prompt {
        Some(pending) => pending,
        None => history.pop().expect("the history holds the summary"),
    };
    Ok(Some((history, prompt)))
}

pub(crate) async fn resume_without_provider_handoff(
    agent: &mut rig::Agent,
    history: Vec<Message>,
    prompt: Message,
    record: impl std::future::Future<Output = anyhow::Result<ClaimStatus>>,
    next_model: impl std::future::Future<Output = anyhow::Result<DynModel<Completion>>>,
) -> anyhow::Result<Option<(Vec<Message>, Message)>> {
    if record.await? == ClaimStatus::Lost {
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
    switch: Option<ProviderSwitchHandoff>,
    omit_prior_reasoning: bool,
) -> AgentProviderResult {
    let legacy_origin = model
        .id()
        .map(|id| rig::message::Origin::new("openai.responses", model.name(), id));
    let options = match generation_options(&request.reasoning_effort) {
        Ok(options) => options,
        Err(error) => return AgentProviderResult::Failed { error },
    };
    let fast_mode = request.fast_mode;
    let target_params = |target: &AgentProvider| {
        (
            options.clone(),
            service_tier_params(target.completion_provider, fast_mode),
        )
    };
    let mut additional_params = if let Some(ProviderSwitchHandoff { handoff, .. }) = &switch {
        match generation_options(&handoff.reasoning_effort) {
            Ok(options) => (
                options,
                service_tier_params(handoff.completion_provider, handoff.fast_mode),
            ),
            Err(error) => return AgentProviderResult::Failed { error },
        }
    } else {
        target_params(&target)
    };
    let tool_call_tracker = ToolCallTracker::new(&request.run_id, &request.claim_id);
    let offer_github_tools = !sprocket_workspace::github::settings().disabled;
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
        request.command_cursors.clone(),
        request.subagent_models.clone(),
        request.subagent_launcher.clone(),
        target.max_yield_ms(request.usage_pricing.cache_write_ttl.as_deref()),
    );
    let cwd = tools.cwd.clone();
    let context_handoff_hook = ContextHandoffHook::new(
        request.context_budget.auto_handoff_token_limit,
        request.context_tokens,
    );
    let agent = AgentBuilder::new(model)
        .tool(tools.apply_patch)
        .tool(tools.control_cmd)
        .tool(tools.exec_cmd)
        .tool(tools.read_skill)
        .tool(tools.scrape_url)
        .tool(tools.web_search)
        .tool(tools.poll_cmd)
        .tool(tools.bind_artifact)
        .tool(tools.list_artifacts)
        .tool(tools.save_artifact)
        .tool(tools.delete_artifact)
        .tool(tools.parse_file)
        .tool(tools.spawn_subagent)
        .tool(tools.control_subagent)
        .tool(tools.poll_subagent)
        .tool(tools.list_subagents)
        .tool(tools.set_cwd);
    let agent = if offer_github_tools {
        agent.tool(tools.link_prs).tool(tools.poll_pr)
    } else {
        agent
    };
    let agent = if request.allow_interaction || request.is_child {
        agent.tool(tools.ask_question).tool(tools.poll_question)
    } else {
        agent
    };
    let agent = if request.is_child {
        agent
    } else if request.allow_interaction {
        agent
            .tool(tools.card_checkout)
            .tool(tools.poll_checkout)
            .tool(tools.report_order)
    } else {
        agent.tool(tools.poll_checkout).tool(tools.report_order)
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
        Err(error) => return transcript_error(error),
    };

    let prompt_hook = AgentPromptHook::new(tool_call_tracker.clone());
    let completion_origin = CompletionOrigin::default();
    let generation_tracker = crate::analytics::GenerationTracker::new(
        &request.run_id,
        &request.thread_id,
        request.share_conversation_content,
        target.completion_provider,
    );
    let mut stream_recovery = StreamRecovery::default();
    let mut recovery_delay = Duration::ZERO;
    let mut finished = match runtime.run_finished_subscription(&request.run_id).await {
        Ok(subscription) => subscription,
        Err(error) => return AgentProviderResult::Failed { error },
    };

    let mut history = request.prior_history;
    if let Some(origin) = &legacy_origin {
        crate::types::assign_unidentified_legacy_history_origin(&mut history, origin);
    }
    let mut prompt = request.prompt;
    let mut pending_begin = Some(request.begin_prompts);
    let mut deferred_prompt = None;
    let mut observed_calls = 0;

    if omit_prior_reasoning {
        match runtime
            .omit_reasoning_replay(&request.run_id, &request.claim_id)
            .await
        {
            Ok(ClaimStatus::Active) => {}
            Ok(ClaimStatus::Lost) => return AgentProviderResult::Cancelled,
            Err(error) => return transcript_error(error),
        }
        history = without_reasoning_traces(history);
    }
    let mut provider_switch = switch.map(|switch| PendingProviderSwitch {
        switch,
        history: history.clone(),
        prompt: prompt.clone(),
    });

    if provider_switch.is_some()
        || (request.defer_prompt_for_context_handoff && context_handoff_hook.handoff_due())
    {
        if request.defer_prompt_for_context_handoff {
            deferred_prompt = Some(prompt);
        } else {
            history.push(prompt);
        }
        prompt = handoff_prompt();
        context_handoff_hook.start_handoff();
    }

    macro_rules! current_usage_source {
        () => {
            usage_source(
                &target,
                request.fast_mode,
                &request.usage_pricing,
                provider_switch
                    .as_ref()
                    .filter(|_| context_handoff_hook.is_writing())
                    .map(|pending| &pending.switch),
            )
        };
    }

    macro_rules! continue_without_handoff {
        ($stream:ident, $generations:lifetime, $agent_run:lifetime, $reason:expr) => {{
            drop($stream);
            let pending = provider_switch.take().expect("provider-switch handoff");
            eprintln!(
                "sprocket-agent: provider switch context handoff failed ({}); continuing on the selected provider without it",
                $reason
            );
            match resume_without_provider_handoff(
                &mut agent,
                pending.history,
                pending.prompt,
                runtime.omit_reasoning_replay(&request.run_id, &request.claim_id),
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
                    additional_params = target_params(&target);
                    context_handoff_hook.restart();
                    continue $generations;
                }
                Ok(None) => break $agent_run AgentProviderResult::Cancelled,
                Err(error) => break $agent_run AgentProviderResult::Failed { error },
            }
        }};
    }

    'agent_run: {
        'generations: loop {
            // A handoff before the prompt begins the run once its summary exists.
            if deferred_prompt.is_none()
                && let Some(begin_prompts) = pending_begin.take()
            {
                match runtime
                    .begin_run(&request.run_id, &request.claim_id, &begin_prompts, None)
                    .await
                {
                    Ok(ClaimStatus::Active) => {}
                    Ok(ClaimStatus::Lost) => break 'agent_run AgentProviderResult::Cancelled,
                    Err(error) => break 'agent_run transcript_error(error),
                }
            }
            let mut final_response_received = false;
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
                .add_hook(stream_recovery.hook())
                .add_hook(generation_tracker.clone())
                .max_invalid_tool_call_retries(MAX_INVALID_TOOL_CALL_RETRIES)
                .stream();
            loop {
                tokio::select! {
                    biased;
                    _ = request.cancellation.cancelled() => {
                        break 'agent_run AgentProviderResult::Cancelled;
                    }
                    _ = sleep(transcript.publish_delay()), if transcript.has_unpublished() => {
                        transcript.publish_if_needed(true);
                    }
                    update = finished.next() => {
                        match update {
                            Some(result) => {
                                match RuntimeClient::decode_run_finished_update(result) {
                                    Ok(true) => break 'agent_run AgentProviderResult::Cancelled,
                                    Ok(false) => {}
                                    Err(error) => break 'agent_run AgentProviderResult::Failed { error },
                                }
                            }
                            None => {
                                break 'agent_run AgentProviderResult::Failed {
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
                            if let Err(error) = transcript.begin_completion_call().await {
                                break 'agent_run transcript_error(error);
                            }
                            observed_calls = calls;
                        }
                        match item {
                            Some(Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(_)))
                            | Some(Ok(rig::agent::MultiTurnStreamItem::FinalResponse(_)))
                                if context_handoff_hook.is_writing() => {}
                            Some(Ok(rig::agent::MultiTurnStreamItem::CompletionCall(call))) => {
                                transcript.finish_completion_call();
                                let source = current_usage_source!();
                                generation_tracker.capture(
                                    call.call_index + 1,
                                    &source,
                                    context_handoff_hook.is_writing(),
                                    call.usage,
                                    call.finish_reason.as_ref(),
                                );
                                if let Some(call_usage) = source.call_usage(call.usage)
                                    && let Err(error) = runtime.record_model_call(
                                        &request.run_id, &request.claim_id, observed_calls, &call_usage,
                                    ).await
                                {
                                    break 'agent_run transcript_error(error);
                                }
                                let tokens = context_handoff_hook.record_usage(call.usage);
                                if !context_handoff_hook.is_writing() {
                                    transcript.record_context_tokens(tokens);
                                    transcript.record_stream_parts();
                                    pending_origin_turn = Some(call.call_index + 1);
                                }
                                if let Some(error) = incomplete_completion_error(call.finish_reason.as_ref()) {
                                    if context_handoff_hook.is_writing() && provider_switch.is_some() {
                                        continue_without_handoff!(stream, 'generations, 'agent_run, format!("{error:#}"));
                                    } else {
                                        break 'agent_run AgentProviderResult::Failed {
                                            error: if context_handoff_hook.is_writing() {
                                                error.context("Context handoff failed: the model response was incomplete.")
                                            } else { error },
                                        };
                                    }
                                }
                            }
                            Some(Ok(rig::agent::MultiTurnStreamItem::FinalResponse(_))) => {
                                final_response_received = true;
                            }
                            Some(Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(
                                Item::Event(StreamEvent::Text { part, text }),
                            ))) => {
                                transcript.push_streamed_text(part.index(), &text);
                            }
                            Some(Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(
                                Item::Event(StreamEvent::Start { part, kind: rig::streaming::PartKind::Reasoning, .. }),
                            ))) => {
                                transcript.push_reasoning(part.index(), "");
                            }
                            Some(Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(
                                Item::Event(StreamEvent::Reasoning { part, text }),
                            ))) => {
                                transcript.push_reasoning(part.index(), &text);
                            }
                            Some(Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(
                                Item::Event(StreamEvent::End { part, content }),
                            ))) => {
                                match content {
                                    AssistantContent::Text(text) => {
                                        transcript.complete_text(part.index(), &text);
                                    }
                                    AssistantContent::Reasoning(reasoning) => {
                                        transcript.complete_reasoning(part.index(), &reasoning);
                                    }
                                    AssistantContent::ToolCall(tool_call) => {
                                        transcript.push_tool_call(part.index(), tool_call);
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
                                // Parts before the cutoff leave the history, so
                                // the context the model keeps must follow it.
                                let live_context = request.workspace_context.prompts(&cwd.get());
                                let handoff = ContextHandoffWrite {
                                    summary: &summary,
                                    completion_attempt_seq: transcript.attempt_seq(),
                                };
                                let begins_run = deferred_prompt.is_some() && pending_begin.take().is_some();
                                let save = async {
                                    if begins_run {
                                        runtime.begin_run(
                                            &request.run_id, &request.claim_id,
                                            &live_context, Some(&handoff),
                                        ).await
                                    } else {
                                        runtime.save_context_handoff(
                                            &request.run_id, &request.claim_id,
                                            &handoff, &live_context,
                                        ).await
                                    }
                                };
                                let handoff_context =
                                    live_context.iter().map(HiddenPrompt::message).collect();
                                match resume_context_handoff(
                                    &mut agent, &summary, handoff_context,
                                    deferred_prompt.take(), save, next_model,
                                ).await {
                                    Ok(Some((next_history, next_prompt))) => {
                                        history = next_history;
                                        prompt = next_prompt;
                                    }
                                    Ok(None) => break 'agent_run AgentProviderResult::Cancelled,
                                    Err(error) => break 'agent_run transcript_error(error),
                                }
                                if let Err(error) = transcript.advance_attempt().await {
                                    break 'agent_run transcript_error(error);
                                }
                                if switching_provider {
                                    additional_params = target_params(&target);
                                }
                                context_handoff_hook.restart();
                                continue 'generations;
                            }
                            Some(Ok(rig::agent::MultiTurnStreamItem::ToolExecutionCommitted { .. })) => {
                                if context_handoff_hook.is_writing() {
                                    if provider_switch.is_some() {
                                        continue_without_handoff!(stream, 'generations, 'agent_run, "the agent called a tool");
                                    }
                                    break 'agent_run AgentProviderResult::Failed {
                                        error: anyhow!("Context handoff failed: the agent called a tool."),
                                    };
                                }
                                if let Err(error) = transcript.begin_next_turn_after_tools().await {
                                    break 'agent_run transcript_error(error);
                                }
                            }
                            Some(Ok(rig::agent::MultiTurnStreamItem::ToolCall { .. })) => {
                                // Rig emits this after the turn commits and before its tools run, so
                                // persisting here keeps the calls when the run stops mid-tool.
                                if !context_handoff_hook.is_writing()
                                    && let Err(error) = transcript.finalize_turn_if_streamed().await
                                {
                                    break 'agent_run transcript_error(error);
                                }
                            }
                            Some(Ok(rig::agent::MultiTurnStreamItem::StreamAssistantItem(_)))
                            | Some(Ok(rig::agent::MultiTurnStreamItem::ToolResult { .. })) => {}
                            Some(Ok(rig::agent::MultiTurnStreamItem::ModelTurnRetried { .. })) => {
                                if let Err(error) = transcript.retry_attempt().await {
                                    break 'agent_run transcript_error(error);
                                }
                                final_response_received = false;
                            }
                            Some(Ok(_)) => {}
                            Some(Err(error)) => {
                                generation_tracker.capture_failure(
                                    &current_usage_source!(),
                                    context_handoff_hook.is_writing(),
                                    &error,
                                );
                                if let Some(handoff_history) = context_handoff_hook.take_handoff_history() {
                                    history = handoff_history;
                                    prompt = handoff_prompt();
                                    context_handoff_hook.start_handoff();
                                    continue 'generations;
                                }
                                if let Some((next_history, next_prompt, delay)) = stream_recovery.resume(&error) {
                                    drop(stream);
                                    eprintln!("sprocket-agent: provider stream was interrupted; retrying the failed turn in {delay:?}");
                                    history = next_history;
                                    prompt = next_prompt;
                                    recovery_delay = delay;
                                    if let Err(error) = transcript.retry_attempt().await {
                                        break 'agent_run transcript_error(error);
                                    }
                                    continue 'generations;
                                }
                                // A provider-switch handoff writes on the previous provider.
                                if provider_switch.is_none()
                                    && !target.fallback_providers.is_empty()
                                    && is_provider_failure(&error)
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
                                        Err(error) => break 'agent_run transcript_error(error),
                                    }
                                    history = without_reasoning_traces(next_history);
                                    prompt = next_prompt;
                                    additional_params = target_params(&target);
                                    if let Err(error) = transcript.retry_attempt().await {
                                        break 'agent_run transcript_error(error);
                                    }
                                    continue 'generations;
                                }
                                if context_handoff_hook.is_writing() && provider_switch.is_some() {
                                    continue_without_handoff!(stream, 'generations, 'agent_run, format!("{error:#}"));
                                } else if context_handoff_hook.is_writing() {
                                    break 'agent_run AgentProviderResult::Failed {
                                        error: anyhow!(error).context("Context handoff failed. Retry to continue the conversation."),
                                    };
                                } else {
                                    break 'agent_run transcript_error(anyhow!(error));
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
                                        error: anyhow!("Context handoff ended without submitting a document."),
                                    };
                                }
                                if !final_response_received {
                                    break 'agent_run AgentProviderResult::Failed {
                                        error: anyhow!("Agent stream ended without a final response."),
                                    };
                                }
                                if let Err(error) = transcript.finalize_turn().await {
                                    break 'agent_run transcript_error(error);
                                }
                                break 'agent_run AgentProviderResult::Completed;
                            }
                        }
                    }
                }
            }
        }
    }
}

fn transcript_error(error: anyhow::Error) -> AgentProviderResult {
    match classify_provider_error(&error) {
        ProviderErrorDisposition::Superseded => AgentProviderResult::Superseded { error },
        ProviderErrorDisposition::Cancelled => AgentProviderResult::Cancelled,
        ProviderErrorDisposition::Failed => AgentProviderResult::Failed { error },
    }
}

#[cfg(test)]
mod reasoning_integration_tests;

#[cfg(test)]
mod tests;
