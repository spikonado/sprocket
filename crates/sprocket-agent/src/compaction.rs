use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::history_json::completion_messages_json;
use rig::agent::{
    AgentHook, CompletionCallAction, CompletionCallEvent, HookContext, ModelTurnAction,
    ModelTurnFinished, RequestPatch, StepEventKind,
};
use rig::completion::{Message, Usage};
use rig::message::{AssistantContent, UserContent};
use tokio::time::timeout;

use crate::convex::RuntimeClient;
use crate::types::{ContextBudget, gateway_api_v1_url};

const CONTEXT_USAGE_TIMEOUT: Duration = Duration::from_secs(5);
const SUMMARIZE_RETRY_DELAY: Duration = Duration::from_millis(250);
/// Keep a small recent tail so the model retains immediate working context.
const RECENT_TAIL_MESSAGES: usize = 6;
/// Must match `COMPACTION_MAX_OUTPUT_TOKENS` in
/// `apps/web/src/convex/lib/contextCompaction.ts`.
const COMPACTION_MAX_OUTPUT_TOKENS: u64 = 12_000;

/// Must match `CONTEXT_COMPACTION_INSTRUCTIONS` in
/// `apps/web/src/convex/lib/contextCompaction.ts`.
const CONTEXT_COMPACTION_INSTRUCTIONS: &str = "Summarize the supplied engineering agent conversation so another agent can continue without the original messages.\n\nPreserve:\n- every user request and the current objective\n- decisions, constraints, plans, and unresolved questions\n- files inspected or changed and the important technical details\n- tool results, errors, tests, and commands that still matter\n- completed work and the exact next steps\n\nBe dense and factual. Do not address the user, continue the task, call tools, or add commentary. Output only the summary.";

// Keep the preamble and <conversation_summary> wrapper in sync with
// `contextSummaryText` in apps/web/src/convex/lib/contextCompaction.ts.
const COMPACTED_CONTEXT_PREAMBLE: &str = "The conversation context was automatically compacted. Treat this summary as authoritative, continue the current task from this state, and do not redo completed work.";

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
    gateway_url: String,
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
        gateway_url: String,
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
            gateway_url,
            state: Arc::new(Mutex::new(CompactionState::default())),
        }
    }
}

impl AgentHook for ContextCompactionHook {
    async fn on_model_turn_finished(
        &self,
        _context: &HookContext,
        event: ModelTurnFinished<'_>,
    ) -> ModelTurnAction {
        self.on_model_turn_finished(event.usage).await;
        ModelTurnAction::Continue
    }

    async fn on_completion_call(
        &self,
        _context: &HookContext,
        event: CompletionCallEvent<'_>,
    ) -> CompletionCallAction {
        self.on_completion_call(event.history).await
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

    async fn on_completion_call(&self, history: &[Message]) -> CompletionCallAction {
        let (last_input_tokens, active_summary) = {
            let state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => return CompletionCallAction::Continue,
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

        let (summary, billed_tokens) = match self.summarize_with_retry(&messages_json).await {
            Ok(summary) => summary,
            Err(error) => {
                eprintln!(
                    "sprocket-agent: context summarization failed for {}: {error:#}",
                    self.run_id
                );
                return self.compaction_failure_flow(active_summary.is_some(), &effective_history);
            }
        };

        let processed_tokens = billed_tokens;
        let summary_text = summary;
        let compacted_summary = context_summary_text(&summary_text);
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
                summary: summary_text,
                replaced_prefix_len,
            });
        }

        let mut compacted = vec![Message::user(compacted_summary)];
        compacted.extend(tail);
        CompletionCallAction::patch(RequestPatch::new().history(compacted))
    }

    async fn summarize_with_retry(&self, messages_json: &str) -> anyhow::Result<(String, u64)> {
        match self.compact_via_gateway(messages_json).await {
            Ok(summary) => Ok(summary),
            Err(first_error) => {
                tokio::time::sleep(SUMMARIZE_RETRY_DELAY).await;
                self.compact_via_gateway(messages_json)
                    .await
                    .map_err(|retry_error| {
                        anyhow::anyhow!(
                            "{retry_error:#}; initial summarization failed: {first_error:#}"
                        )
                    })
            }
        }
    }

    async fn compact_via_gateway(&self, messages_json: &str) -> anyhow::Result<(String, u64)> {
        let credential = self
            .runtime
            .issue_gateway_credential(&self.run_id, &self.claim_id)
            .await?;
        let url = format!("{}/responses", gateway_api_v1_url(&self.gateway_url));
        let body = serde_json::json!({
            "model": self.model,
            "instructions": CONTEXT_COMPACTION_INSTRUCTIONS,
            "input": [{ "role": "user", "content": messages_json }],
            "max_output_tokens": COMPACTION_MAX_OUTPUT_TOKENS,
            "stream": false,
            "reasoning": { "effort": self.reasoning_effort },
            "service_tier": if self.service_tier == "fast" { "priority" } else { "standard" }
        });
        let response = reqwest::Client::new()
            .post(url)
            .bearer_auth(&credential.token)
            .json(&body)
            .send()
            .await?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            anyhow::bail!("gateway compaction failed: {status} {text}");
        }
        let payload: serde_json::Value = response.json().await?;
        let summary = extract_response_text(&payload)
            .ok_or_else(|| anyhow::anyhow!("gateway compaction response had no text"))?;
        Ok((summary, extract_response_usage(&payload)?))
    }

    fn compaction_failure_flow(
        &self,
        has_active_summary: bool,
        effective_history: &[Message],
    ) -> CompletionCallAction {
        let estimated = estimate_context_tokens(effective_history);
        if estimated >= self.context_budget.context_window_tokens {
            return CompletionCallAction::stop(format!(
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

fn continue_with_history(has_active_summary: bool, history: Vec<Message>) -> CompletionCallAction {
    if has_active_summary {
        CompletionCallAction::patch(RequestPatch::new().history(history))
    } else {
        CompletionCallAction::Continue
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

fn extract_response_text(payload: &serde_json::Value) -> Option<String> {
    if let Some(text) = payload.get("output_text").and_then(|value| value.as_str()) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let mut pieces = Vec::new();
    let output = payload.get("output")?.as_array()?;
    for item in output {
        let content = item.get("content").and_then(|value| value.as_array());
        if let Some(content) = content {
            for part in content {
                if part.get("type").and_then(|value| value.as_str()) == Some("output_text") {
                    if let Some(text) = part.get("text").and_then(|value| value.as_str()) {
                        pieces.push(text.to_string());
                    }
                }
            }
        }
    }
    let joined = pieces.join("").trim().to_string();
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

/// Input + output tokens actually billed for the compaction call. The gateway
/// always returns `usage`, so a response without it is a protocol violation.
fn extract_response_usage(payload: &serde_json::Value) -> anyhow::Result<u64> {
    let usage = payload
        .get("usage")
        .ok_or_else(|| anyhow::anyhow!("gateway compaction response had no usage"))?;
    let input_tokens = usage
        .get("input_tokens")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| anyhow::anyhow!("gateway compaction usage had no input_tokens"))?;
    Ok(input_tokens.saturating_add(
        usage
            .get("output_tokens")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
    ))
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
    match serde_json::to_string(messages) {
        Ok(serialized) => serialized.len().div_ceil(3) as u64,
        Err(error) => {
            eprintln!(
                "sprocket-agent: failed to serialize messages for context token estimate: {error}"
            );
            let content_bytes: usize = messages.iter().map(rough_message_content_bytes).sum();
            content_bytes.max(messages.len()).div_ceil(3) as u64
        }
    }
}

fn rough_message_content_bytes(message: &Message) -> usize {
    match message {
        Message::System { content } => content.len(),
        Message::User { content } => content
            .iter()
            .map(|part| match part {
                UserContent::Text(text) => text.text.len(),
                _ => 1,
            })
            .sum(),
        Message::Assistant { content, .. } => content
            .iter()
            .map(|part| match part {
                AssistantContent::Text(text) => text.text.len(),
                _ => 1,
            })
            .sum(),
    }
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
    use rig::message::{AssistantContent, ToolResultContent};

    fn user_text(text: &str) -> Message {
        Message::user(text)
    }

    fn assistant_tool_call(id: &str) -> Message {
        Message::Assistant {
            id: None,
            content: vec![AssistantContent::tool_call(
                id,
                "exec_command",
                serde_json::json!({ "cmd": "pwd" }),
            )],
        }
    }

    fn user_tool_result(id: &str) -> Message {
        Message::User {
            content: vec![UserContent::tool_result(
                id,
                "exec_command",
                vec![ToolResultContent::text("ok")],
            )],
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

    #[test]
    fn extracts_billed_usage_from_gateway_compaction_response() {
        let payload = serde_json::json!({
            "output_text": "summary",
            "usage": {
                "input_tokens": 100,
                "output_tokens": 30,
                "total_tokens": 130
            }
        });
        assert_eq!(extract_response_usage(&payload).unwrap_or(0), 130);
        assert!(extract_response_text(&payload).is_some());
    }

    #[test]
    fn rejects_gateway_compaction_responses_without_billed_usage() {
        assert!(extract_response_usage(&serde_json::json!({ "output_text": "summary" })).is_err());
        assert!(
            extract_response_usage(&serde_json::json!({ "usage": {} })).is_err(),
            "missing input_tokens must not fabricate a billed count"
        );
    }
}
