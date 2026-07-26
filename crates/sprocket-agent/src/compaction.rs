use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rig::agent::{AgentHook, Flow, RequestPatch, StepEvent, StepEventKind};
use rig::client::CompletionClient;
use rig::completion::Prompt;
use rig::completion::{CompletionModel, Message, Usage};
use rig::message::UserContent;
use rig::providers::{chatgpt, openai};
use sprocket_convex_provider::{Usage as CompletionUsage, completion_messages_json};
use tokio::time::timeout;
use uuid::Uuid;

use crate::convex::{RuntimeClient, SummarizeResponse};
use crate::types::ContextBudget;

const CONTEXT_USAGE_TIMEOUT: Duration = Duration::from_secs(5);
const SUMMARIZE_RETRY_DELAY: Duration = Duration::from_millis(250);
/// Keep a small recent tail so the model retains immediate working context.
const RECENT_TAIL_MESSAGES: usize = 6;
/// Must match `COMPACTION_MAX_OUTPUT_TOKENS` in
/// `apps/web/src/convex/lib/contextCompaction.ts`.
const COMPACTION_MAX_OUTPUT_TOKENS: u64 = 12_000;

// Keep the preamble and <conversation_summary> wrapper in sync with
// `contextSummaryText` in apps/web/src/convex/lib/contextCompaction.ts.
const COMPACTED_CONTEXT_PREAMBLE: &str = "The conversation context was automatically compacted. Treat this summary as authoritative, continue the current task from this state, and do not redo completed work.";

// Keep in sync with `CONTEXT_COMPACTION_INSTRUCTIONS` in `apps/web/src/convex/lib/contextCompaction.ts`.
const CONTEXT_COMPACTION_INSTRUCTIONS: &str = "Summarize the supplied engineering agent conversation so another agent can continue without the original messages.\n\nPreserve:\n- every user request and the current objective\n- decisions, constraints, plans, and unresolved questions\n- files inspected or changed and the important technical details\n- tool results, errors, tests, and commands that still matter\n- completed work and the exact next steps\n\nBe dense and factual. Do not address the user, continue the task, call tools, or add commentary. Output only the summary.";

#[derive(Clone, Debug)]
struct CompactedContext {
    summary: String,
    replaced_prefix_len: usize,
}

#[derive(Debug, Default)]
struct CompactionState {
    last_input_tokens: u64,
    active_summary: Option<CompactedContext>,
}

#[derive(Clone)]
pub(crate) struct ContextCompactionHook {
    runtime: RuntimeClient,
    run_id: String,
    claim_id: String,
    model: String,
    reasoning_effort: String,
    service_tier: String,
    context_budget: ContextBudget,
    prior_history_len: usize,
    byok_openai_api_key: Option<Arc<str>>,
    byok_chatgpt_auth_json: Option<Arc<str>>,
    state: Arc<Mutex<CompactionState>>,
}

impl ContextCompactionHook {
    pub(crate) fn new(
        runtime: RuntimeClient,
        run_id: String,
        claim_id: String,
        model: String,
        reasoning_effort: String,
        service_tier: String,
        context_budget: ContextBudget,
        prior_history_len: usize,
    ) -> Self {
        Self {
            runtime,
            run_id,
            claim_id,
            model,
            reasoning_effort,
            service_tier,
            context_budget,
            prior_history_len,
            byok_openai_api_key: None,
            byok_chatgpt_auth_json: None,
            state: Arc::new(Mutex::new(CompactionState::default())),
        }
    }

    pub(crate) fn with_openai_api_key(mut self, api_key: impl Into<String>) -> Self {
        self.byok_openai_api_key = Some(api_key.into().into());
        self.byok_chatgpt_auth_json = None;
        self
    }

    pub(crate) fn with_chatgpt_auth_json(mut self, auth_json: impl Into<String>) -> Self {
        self.byok_chatgpt_auth_json = Some(auth_json.into().into());
        self.byok_openai_api_key = None;
        self
    }
}

impl<M> AgentHook<M> for ContextCompactionHook
where
    M: CompletionModel,
{
    async fn on_event(&self, _context: &rig::agent::HookContext, event: StepEvent<'_, M>) -> Flow {
        match event {
            StepEvent::ModelTurnFinished { usage, .. } => {
                self.on_model_turn_finished(usage).await;
                Flow::cont()
            }
            StepEvent::CompletionCall { history, .. } => self.on_completion_call(history).await,
            _ => Flow::cont(),
        }
    }

    fn observes(&self, kind: StepEventKind) -> bool {
        matches!(
            kind,
            StepEventKind::CompletionCall | StepEventKind::ModelTurnFinished
        )
    }
}

impl ContextCompactionHook {
    async fn on_model_turn_finished(&self, usage: Usage) {
        let context_tokens = context_input_tokens(&usage);
        let processed_tokens = context_tokens.saturating_add(usage.output_tokens);
        if let Ok(mut state) = self.state.lock() {
            state.last_input_tokens = context_tokens;
        }

        match timeout(
            CONTEXT_USAGE_TIMEOUT,
            self.runtime.record_context_usage(
                &self.run_id,
                &self.claim_id,
                context_tokens,
                processed_tokens,
            ),
        )
        .await
        {
            Ok(Ok(true)) => {}
            Ok(Ok(false)) => {
                eprintln!(
                    "sprocket-agent: recordContextUsage skipped for {} (claim no longer active)",
                    self.run_id
                );
            }
            Ok(Err(error)) => {
                eprintln!(
                    "sprocket-agent: recordContextUsage failed for {}: {error:#}",
                    self.run_id
                );
            }
            Err(_) => {
                eprintln!(
                    "sprocket-agent: recordContextUsage timed out for {}",
                    self.run_id
                );
            }
        }
    }

    async fn on_completion_call(&self, history: &[Message]) -> Flow {
        let (last_input_tokens, active_summary) = {
            let state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => return Flow::cont(),
            };
            (state.last_input_tokens, state.active_summary.clone())
        };

        let effective_history = rebuild_effective_history(history, active_summary.as_ref());
        if !should_compact(
            last_input_tokens,
            self.context_budget.auto_compact_token_limit,
            &effective_history,
        ) {
            return continue_with_history(active_summary.is_some(), effective_history);
        }

        let prior_boundary = prior_boundary_in_effective(
            active_summary.as_ref(),
            self.prior_history_len,
            history.len(),
        );
        let split = choose_split_index(
            &effective_history,
            prior_boundary,
            self.context_budget.auto_compact_token_limit,
        );
        if split == 0 {
            return continue_with_history(active_summary.is_some(), effective_history);
        }

        let prefix = &effective_history[..split];
        let tail = effective_history[split..].to_vec();
        let messages_json = match completion_messages_json(prefix.iter()) {
            Ok(value) => value.to_string(),
            Err(error) => {
                eprintln!(
                    "sprocket-agent: failed to serialize compaction messages for {}: {error}",
                    self.run_id
                );
                return self.compaction_failure_flow(active_summary.is_some(), &effective_history);
            }
        };

        let summary = match self.summarize_with_retry(&messages_json).await {
            Ok(summary) => summary,
            Err(error) => {
                eprintln!(
                    "sprocket-agent: context summarization failed for {}: {error:#}",
                    self.run_id
                );
                return self.compaction_failure_flow(active_summary.is_some(), &effective_history);
            }
        };

        let processed_tokens = summary.processed_tokens();
        let summary_text = summary.summary;
        let replaced_prefix_len =
            next_replaced_prefix_len(active_summary.as_ref(), history.len(), split);
        let persist_for_future_runs =
            should_persist_for_future_runs(self.prior_history_len, replaced_prefix_len);

        match self
            .runtime
            .save_context_compaction(
                &self.run_id,
                &self.claim_id,
                &summary_text,
                processed_tokens,
                persist_for_future_runs,
            )
            .await
        {
            Ok(true) => {}
            Ok(false) => {
                eprintln!(
                    "sprocket-agent: saveContextCompaction skipped for {} (claim no longer active)",
                    self.run_id
                );
            }
            Err(error) => {
                eprintln!(
                    "sprocket-agent: saveContextCompaction failed for {}: {error:#}",
                    self.run_id
                );
            }
        }

        if let Ok(mut state) = self.state.lock() {
            state.active_summary = Some(CompactedContext {
                summary: summary_text.clone(),
                replaced_prefix_len,
            });
        }

        let mut compacted = vec![Message::user(context_summary_text(&summary_text))];
        compacted.extend(tail);
        Flow::patch_request(RequestPatch::new().history(compacted))
    }

    async fn summarize_with_retry(&self, messages_json: &str) -> anyhow::Result<SummarizeResponse> {
        match self.summarize_once(messages_json).await {
            Ok(response) => Ok(response),
            Err(first_error) => {
                tokio::time::sleep(SUMMARIZE_RETRY_DELAY).await;
                self.summarize_once(messages_json)
                    .await
                    .map_err(|retry_error| {
                        anyhow::anyhow!(
                            "{retry_error:#}; initial summarization failed: {first_error:#}"
                        )
                    })
            }
        }
    }

    async fn summarize_once(&self, messages_json: &str) -> anyhow::Result<SummarizeResponse> {
        if let Some(api_key) = self.byok_openai_api_key.as_deref() {
            return summarize_with_openai(api_key, &self.model, messages_json).await;
        }
        if let Some(auth_json) = self.byok_chatgpt_auth_json.as_deref() {
            return summarize_with_chatgpt(auth_json, &self.model, messages_json).await;
        }
        self.runtime
            .summarize(
                &self.run_id,
                &self.claim_id,
                &self.model,
                &self.reasoning_effort,
                &self.service_tier,
                messages_json,
            )
            .await
    }

    fn compaction_failure_flow(
        &self,
        has_active_summary: bool,
        effective_history: &[Message],
    ) -> Flow {
        let estimated = estimate_context_tokens(effective_history);
        if estimated >= self.context_budget.context_window_tokens {
            return Flow::terminate(format!(
                "Context compaction failed and the conversation (~{estimated} tokens) exceeds the model context window ({} tokens).",
                self.context_budget.context_window_tokens
            ));
        }
        continue_with_history(has_active_summary, effective_history.to_vec())
    }
}

fn context_input_tokens(usage: &Usage) -> u64 {
    usage
        .input_tokens
        .saturating_add(usage.cached_input_tokens)
        .saturating_add(usage.cache_creation_input_tokens)
}

fn context_summary_text(summary: &str) -> String {
    format!(
        "{COMPACTED_CONTEXT_PREAMBLE}\n\n<conversation_summary>\n{summary}\n</conversation_summary>"
    )
}

fn continue_with_history(has_active_summary: bool, history: Vec<Message>) -> Flow {
    if has_active_summary {
        Flow::patch_request(RequestPatch::new().history(history))
    } else {
        Flow::cont()
    }
}

fn rebuild_effective_history(
    history: &[Message],
    active_summary: Option<&CompactedContext>,
) -> Vec<Message> {
    let Some(active) = active_summary else {
        return history.to_vec();
    };
    let mut effective = vec![Message::user(context_summary_text(&active.summary))];
    let suffix_start = active.replaced_prefix_len.min(history.len());
    effective.extend(history[suffix_start..].iter().cloned());
    effective
}

fn next_replaced_prefix_len(
    active_summary: Option<&CompactedContext>,
    raw_history_len: usize,
    effective_split: usize,
) -> usize {
    match active_summary {
        None => effective_split.min(raw_history_len),
        Some(active) => {
            // effective = [summary] + raw[replaced_prefix_len..]
            // compacting effective[..split] advances the raw cutoff by (split - 1).
            let advanced = effective_split.saturating_sub(1);
            active
                .replaced_prefix_len
                .saturating_add(advanced)
                .min(raw_history_len)
        }
    }
}

fn should_compact(
    last_input_tokens: u64,
    auto_compact_token_limit: u64,
    messages: &[Message],
) -> bool {
    if last_input_tokens >= auto_compact_token_limit {
        return true;
    }
    estimate_context_tokens(messages) >= auto_compact_token_limit
}

fn estimate_context_tokens(messages: &[Message]) -> u64 {
    let serialized = serde_json::to_string(messages).unwrap_or_default();
    serialized.len().div_ceil(3) as u64
}

fn prior_boundary_in_effective(
    active_summary: Option<&CompactedContext>,
    prior_history_len: usize,
    raw_history_len: usize,
) -> Option<usize> {
    let boundary = prior_history_len.min(raw_history_len);
    match active_summary {
        None => (boundary > 0).then_some(boundary),
        Some(active) => {
            // effective = [summary] + raw[replaced_prefix_len..]
            if boundary <= active.replaced_prefix_len {
                return None;
            }
            Some(1 + (boundary - active.replaced_prefix_len))
        }
    }
}

fn choose_split_index(
    history: &[Message],
    prior_boundary_in_effective: Option<usize>,
    auto_compact_token_limit: u64,
) -> usize {
    if history.len() <= 1 {
        return 0;
    }

    // Prefer compacting exactly the prior-history prefix when the remaining
    // tail (plus room for the summary) still fits under the compact limit.
    if let Some(boundary) = prior_boundary_in_effective {
        let boundary = adjust_split_for_tool_results(history, boundary);
        if boundary > 0
            && estimate_context_tokens(&history[boundary..]) + COMPACTION_MAX_OUTPUT_TOKENS
                < auto_compact_token_limit
        {
            if !(boundary == 1 && is_summary_user_message(&history[0])) {
                return boundary;
            }
        }
    }

    let mut split = history.len().saturating_sub(RECENT_TAIL_MESSAGES);
    if split == 0 {
        split = history.len().saturating_sub(1);
    }
    split = adjust_split_for_tool_results(history, split);

    // Compacting only the summary message is pointless.
    if split == 1 && is_summary_user_message(&history[0]) {
        return 0;
    }

    split
}

fn adjust_split_for_tool_results(history: &[Message], mut split: usize) -> usize {
    split = split.min(history.len());
    while split > 0 && split < history.len() && is_tool_result_user(&history[split]) {
        split -= 1;
    }
    split
}

/// Durable thread summaries require a prior-run cutoff. Persist only when prior
/// history exists and the compacted prefix covers all of it.
fn should_persist_for_future_runs(prior_history_len: usize, replaced_prefix_len: usize) -> bool {
    prior_history_len > 0 && replaced_prefix_len >= prior_history_len
}

fn is_tool_result_user(message: &Message) -> bool {
    match message {
        Message::User { content } => content
            .iter()
            .any(|part| matches!(part, UserContent::ToolResult(_))),
        _ => false,
    }
}

fn is_summary_user_message(message: &Message) -> bool {
    match message {
        Message::User { content } => content.iter().any(|part| match part {
            UserContent::Text(text) => {
                text.text.contains("<conversation_summary>")
                    && text.text.contains(COMPACTED_CONTEXT_PREAMBLE)
            }
            _ => false,
        }),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rig::OneOrMany;
    use rig::message::{
        AssistantContent, Text, ToolCall, ToolFunction, ToolResult, ToolResultContent,
    };

    fn user_text(text: &str) -> Message {
        Message::user(text)
    }

    fn assistant_tool_call(id: &str) -> Message {
        Message::Assistant {
            id: None,
            content: OneOrMany::one(AssistantContent::ToolCall(ToolCall {
                id: id.to_string(),
                call_id: Some(id.to_string()),
                function: ToolFunction {
                    name: "exec_command".to_string(),
                    arguments: serde_json::json!({ "cmd": "pwd" }),
                },
                signature: None,
                additional_params: None,
            })),
        }
    }

    fn user_tool_result(id: &str) -> Message {
        Message::User {
            content: OneOrMany::one(UserContent::ToolResult(ToolResult {
                id: id.to_string(),
                call_id: Some(id.to_string()),
                content: OneOrMany::one(ToolResultContent::Text(Text::new("ok"))),
            })),
        }
    }

    #[test]
    fn split_point_does_not_orphan_leading_tool_result() {
        let history = vec![
            user_text("old work"),
            assistant_tool_call("call_1"),
            user_tool_result("call_1"),
            user_text("continue"),
            assistant_tool_call("call_2"),
            user_tool_result("call_2"),
            user_text("latest"),
        ];

        // Force a recent-tail landing that would otherwise start on a tool result.
        let chosen = choose_split_index(&history, None, u64::MAX);
        assert!(chosen > 0);
        assert!(!is_tool_result_user(&history[chosen]));
        assert_eq!(
            adjust_split_for_tool_results(&history, 2),
            1,
            "tool-result at index 2 must pull the split back onto its tool call"
        );
    }

    #[test]
    fn prefers_prior_history_boundary_when_tail_fits() {
        let history = vec![
            user_text("prior a"),
            user_text("prior b"),
            user_text("current"),
        ];
        let chosen = choose_split_index(&history, Some(2), 100_000);
        assert_eq!(chosen, 2);
    }

    #[test]
    fn rebuilds_effective_history_with_active_summary() {
        let history = vec![
            user_text("covered"),
            user_text("kept a"),
            user_text("kept b"),
        ];
        let active = CompactedContext {
            summary: "Prior work is done.".to_string(),
            replaced_prefix_len: 1,
        };

        let effective = rebuild_effective_history(&history, Some(&active));
        assert_eq!(effective.len(), 3);
        match &effective[0] {
            Message::User { content } => {
                let text = match content.iter().next() {
                    Some(UserContent::Text(text)) => &text.text,
                    other => panic!("expected summary text, got {other:?}"),
                };
                assert!(text.contains("Prior work is done."));
                assert!(text.contains("<conversation_summary>"));
            }
            other => panic!("expected summary user message, got {other:?}"),
        }
        assert_eq!(effective[1], user_text("kept a"));
        assert_eq!(effective[2], user_text("kept b"));
    }

    #[test]
    fn should_compact_uses_usage_and_preflight_estimate() {
        let small = vec![user_text("hi")];
        assert!(!should_compact(10, 100, &small));
        assert!(should_compact(100, 100, &small));

        let large_text = "x".repeat(400);
        let large = vec![user_text(&large_text)];
        // ceil(len/3) for a serialized message is well above 50.
        assert!(should_compact(0, 50, &large));
        assert!(estimate_context_tokens(&large) >= 50);
    }

    #[test]
    fn advances_replaced_prefix_len_in_raw_coordinates() {
        assert_eq!(next_replaced_prefix_len(None, 10, 4), 4);
        let active = CompactedContext {
            summary: "s".to_string(),
            replaced_prefix_len: 3,
        };
        // effective split 3 => summary + 2 raw messages compacted => raw cutoff 5
        assert_eq!(next_replaced_prefix_len(Some(&active), 10, 3), 5);
    }

    #[test]
    fn persist_gate_requires_covered_prior_history() {
        assert!(!should_persist_for_future_runs(0, 0));
        assert!(!should_persist_for_future_runs(0, 4));
        assert!(!should_persist_for_future_runs(6, 4));
        assert!(should_persist_for_future_runs(6, 6));
        assert!(should_persist_for_future_runs(6, 8));
    }
}

async fn summarize_with_openai(
    api_key: &str,
    model: &str,
    messages_json: &str,
) -> anyhow::Result<SummarizeResponse> {
    let client = openai::Client::new(api_key).map_err(|error| {
        anyhow::anyhow!("failed to build OpenAI client for compaction: {error}")
    })?;
    summarize_with_client(client, model, messages_json, "OpenAI").await
}

async fn summarize_with_chatgpt(
    auth_json: &str,
    model: &str,
    messages_json: &str,
) -> anyhow::Result<SummarizeResponse> {
    let path = std::env::temp_dir().join(format!(
        "sprocket-chatgpt-compaction-{}.json",
        Uuid::new_v4()
    ));
    std::fs::write(&path, auth_json)
        .map_err(|error| anyhow::anyhow!("failed to materialize ChatGPT auth.json: {error}"))?;
    let _cleanup = TempPathCleanup(path.clone());
    let client = chatgpt::Client::builder()
        .oauth()
        .auth_file(&path)
        .allow_device_flow(false)
        .build()
        .map_err(|error| {
            anyhow::anyhow!("failed to build ChatGPT client for compaction: {error}")
        })?;
    summarize_with_client(client, model, messages_json, "ChatGPT").await
}

async fn summarize_with_client<C>(
    client: C,
    model: &str,
    messages_json: &str,
    label: &str,
) -> anyhow::Result<SummarizeResponse>
where
    C: CompletionClient,
    C::CompletionModel: 'static,
{
    let agent = client
        .agent(model)
        .preamble(CONTEXT_COMPACTION_INSTRUCTIONS)
        .max_tokens(COMPACTION_MAX_OUTPUT_TOKENS)
        .build();
    let prompt = format!(
        "Conversation messages JSON to summarize:\n{messages_json}\n\nReturn only the summary."
    );
    let summary = agent
        .prompt(prompt)
        .await
        .map_err(|error| anyhow::anyhow!("{label} compaction failed: {error}"))?;
    Ok(SummarizeResponse {
        summary,
        usage: CompletionUsage::default(),
    })
}

struct TempPathCleanup(PathBuf);

impl Drop for TempPathCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
