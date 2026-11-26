use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use rig::agent::{
    AgentHook, DispatchAction, DispatchEvent, HookContext, InvalidToolCallAction,
    InvalidToolCallContext, InvalidToolCallReason, StepEventKind,
};
use sha2::{Digest, Sha256};

use crate::tools::{AGENT_TOOLS, NormalizeToolArgs};

fn agent_tool_normalizer(tool_name: &str) -> Option<NormalizeToolArgs> {
    AGENT_TOOLS
        .iter()
        .find_map(|(name, normalize)| (*name == tool_name).then_some(*normalize))
}

/// The model's raw arguments and a tool's serialized `Args` differ in omitted defaults and `null`s,
/// so both sides of a dispatch match go through the tool's `Args` type.
fn normalized_tool_args(tool_name: &str, args: &serde_json::Value) -> serde_json::Value {
    agent_tool_normalizer(tool_name)
        .and_then(|normalize| normalize(args))
        .unwrap_or_else(|| args.clone())
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ToolInvocationAssignment {
    pub(crate) call_id: String,
    pub(crate) tool_invocation_id: String,
    pub(crate) attempt_seq: u64,
    pub(crate) stream_id: String,
}

#[derive(Debug)]
struct ToolCallState {
    run_id: String,
    claim_id: String,
    attempt_seq: u64,
    stream_id: String,
    invocations_by_internal_id: HashMap<String, ToolInvocationAssignment>,
    unbound_invocations: HashMap<String, VecDeque<ToolInvocationAssignment>>,
    dispatches_by_tool: HashMap<String, VecDeque<PendingDispatch>>,
    completion: Vec<ToolInvocationAssignment>,
}

#[derive(Debug)]
struct PendingDispatch {
    args: serde_json::Value,
    assignment: ToolInvocationAssignment,
}

#[derive(Clone, Debug)]
pub(crate) struct ToolCallTracker(Arc<Mutex<ToolCallState>>);

pub(crate) fn completion_stream_id(run_id: &str, claim_id: &str, attempt_seq: u64) -> String {
    format!("agent:{run_id}:{claim_id}:{attempt_seq}")
}

impl ToolCallTracker {
    pub(crate) fn new(run_id: &str, claim_id: &str) -> Self {
        Self(Arc::new(Mutex::new(ToolCallState {
            run_id: run_id.to_owned(),
            claim_id: claim_id.to_owned(),
            attempt_seq: 1,
            stream_id: completion_stream_id(run_id, claim_id, 1),
            invocations_by_internal_id: HashMap::new(),
            unbound_invocations: HashMap::new(),
            dispatches_by_tool: HashMap::new(),
            completion: Vec::new(),
        })))
    }

    pub(crate) fn begin_attempt(&self, attempt_seq: u64, stream_id: &str) {
        if let Ok(mut state) = self.0.lock() {
            state.attempt_seq = attempt_seq;
            state.stream_id = stream_id.to_owned();
            state.invocations_by_internal_id.clear();
            state.unbound_invocations.clear();
            state.dispatches_by_tool.clear();
            state.completion.clear();
        }
    }

    pub(crate) fn record_parts(&self, parts: &[sprocket_transcript::LiveAssistantPart]) {
        use sprocket_transcript::LiveAssistantPart;

        self.record_turn(parts.iter().map(|part| match part {
            LiveAssistantPart::ToolCall { call_id, .. } => Some(call_id.as_str()),
            _ => None,
        }));
    }

    pub(crate) fn annotate_items(&self, items: &mut [serde_json::Value]) {
        let Ok(state) = self.0.lock() else {
            return;
        };
        for (item, invocation) in items
            .iter_mut()
            .filter(|item| item["type"] == "tool-call")
            .zip(&state.completion)
        {
            item["toolInvocationId"] = invocation.tool_invocation_id.clone().into();
        }
    }

    pub(crate) fn assignment_for_dispatch(
        &self,
        internal_call_id: &str,
        call_id: Option<&str>,
    ) -> Option<ToolInvocationAssignment> {
        let mut state = self.0.lock().ok()?;
        if let Some(assignment) = state.invocations_by_internal_id.get(internal_call_id) {
            return Some(assignment.clone());
        }
        let call_id = call_id?;
        let assignment = state.unbound_invocations.get_mut(call_id)?.pop_front()?;
        state
            .invocations_by_internal_id
            .insert(internal_call_id.to_owned(), assignment.clone());
        Some(assignment)
    }

    fn prepare_dispatch(
        &self,
        tool_name: &str,
        internal_call_id: &str,
        call_id: Option<&str>,
        args: &str,
    ) {
        let Some(assignment) = self.assignment_for_dispatch(internal_call_id, call_id) else {
            return;
        };
        let Ok(args) = serde_json::from_str(args) else {
            return;
        };
        let args = normalized_tool_args(tool_name, &args);
        if let Ok(mut state) = self.0.lock() {
            state
                .dispatches_by_tool
                .entry(tool_name.to_owned())
                .or_default()
                .push_back(PendingDispatch { args, assignment });
        }
    }

    pub(crate) fn claim_dispatch(
        &self,
        tool_name: &str,
        args: &serde_json::Value,
    ) -> Option<ToolInvocationAssignment> {
        let args = normalized_tool_args(tool_name, args);
        let mut state = self.0.lock().ok()?;
        let pending = state.dispatches_by_tool.get_mut(tool_name)?;
        let index = pending.iter().position(|dispatch| dispatch.args == args)?;
        pending.remove(index).map(|dispatch| dispatch.assignment)
    }

    fn record_turn<'a>(&self, content: impl IntoIterator<Item = Option<&'a str>>) {
        let Ok(mut state) = self.0.lock() else {
            return;
        };
        state.completion.clear();
        for (index, call_id) in content.into_iter().enumerate() {
            let Some(call_id) = call_id else {
                continue;
            };
            let assignment = ToolInvocationAssignment {
                call_id: call_id.to_owned(),
                tool_invocation_id: tool_invocation_id(
                    &state.run_id,
                    &state.claim_id,
                    state.attempt_seq,
                    index as u64,
                ),
                attempt_seq: state.attempt_seq,
                stream_id: state.stream_id.clone(),
            };
            state
                .unbound_invocations
                .entry(call_id.to_owned())
                .or_default()
                .push_back(assignment.clone());
            state.completion.push(assignment);
        }
    }
}

fn tool_invocation_id(run_id: &str, claim_id: &str, attempt_seq: u64, index: u64) -> String {
    let mut hash = Sha256::new();
    for value in [
        "invocation",
        run_id,
        claim_id,
        &attempt_seq.to_string(),
        &index.to_string(),
    ] {
        hash.update((value.len() as u64).to_le_bytes());
        hash.update(value.as_bytes());
    }
    format!("agent-invocation-{}", hex::encode(hash.finalize()))
}

#[derive(Clone)]
pub(crate) struct AgentPromptHook {
    tracker: ToolCallTracker,
}

impl AgentPromptHook {
    pub(crate) fn new(tracker: ToolCallTracker) -> Self {
        Self { tracker }
    }
}

impl AgentHook for AgentPromptHook {
    async fn on_dispatch(
        &self,
        _context: &HookContext,
        event: DispatchEvent<'_>,
    ) -> DispatchAction {
        if let Some(tool_name) = event.tool_name()
            && agent_tool_normalizer(tool_name).is_some()
        {
            let call_id = event.call_id.map(|id| id.wire());
            self.tracker.prepare_dispatch(
                tool_name,
                &event.id.to_string(),
                call_id.as_deref(),
                event.tool_args().unwrap_or_default(),
            );
        }
        DispatchAction::proceed()
    }

    async fn on_invalid_tool_call(
        &self,
        _context: &HookContext,
        event: &InvalidToolCallContext,
    ) -> Option<InvalidToolCallAction> {
        Some(resolve_invalid_tool_call(event))
    }

    fn observes(&self, kind: StepEventKind) -> bool {
        kind == StepEventKind::ToolDispatch
    }
}

fn resolve_invalid_tool_call(context: &InvalidToolCallContext) -> InvalidToolCallAction {
    if let InvalidToolCallReason::MalformedArguments { error } = &context.reason {
        return InvalidToolCallAction::retry(format!(
            "Tool `{}` received malformed arguments: {error}. Submit valid JSON matching its schema.",
            context.tool_name,
        ));
    }
    resolve_invalid_tool_name(&context.tool_name, &context.available_tools)
}

fn resolve_invalid_tool_name(tool_name: &str, available_tools: &[String]) -> InvalidToolCallAction {
    let candidates = if available_tools.is_empty() {
        AGENT_TOOLS
            .iter()
            .map(|(name, _)| (*name).to_string())
            .collect()
    } else {
        available_tools.to_vec()
    };

    if let Some(repaired) = repair_tool_name(tool_name, &candidates) {
        return InvalidToolCallAction::repair(repaired);
    }

    InvalidToolCallAction::retry(format!(
        "Unknown or disallowed tool `{}`. Use one of: {}.",
        tool_name,
        candidates.join(", ")
    ))
}

fn repair_tool_name(emitted: &str, candidates: &[String]) -> Option<String> {
    let normalized_emitted = normalize_tool_name(emitted);
    if normalized_emitted.is_empty() {
        return None;
    }

    let exact = candidates
        .iter()
        .find(|candidate| normalize_tool_name(candidate) == normalized_emitted);
    if let Some(match_name) = exact {
        return Some(match_name.clone());
    }

    let mut close_matches = candidates
        .iter()
        .filter_map(|candidate| {
            let normalized_candidate = normalize_tool_name(candidate);
            let distance = levenshtein(&normalized_emitted, &normalized_candidate);
            let max_distance = (normalized_candidate.len() / 3).max(1);
            if distance <= max_distance {
                Some((distance, candidate.clone()))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    if close_matches.is_empty() {
        return None;
    }

    close_matches.sort_by_key(|(distance, name)| (*distance, name.clone()));
    let (best_distance, best_name) = &close_matches[0];
    let unique_best = close_matches
        .iter()
        .filter(|(distance, _)| distance == best_distance)
        .count()
        == 1;
    unique_best.then(|| best_name.clone())
}

fn normalize_tool_name(name: &str) -> String {
    name.chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .map(|ch| {
            if ch == '-' {
                '_'
            } else {
                ch.to_ascii_lowercase()
            }
        })
        .collect()
}

fn levenshtein(left: &str, right: &str) -> usize {
    let left_chars: Vec<char> = left.chars().collect();
    let right_chars: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right_chars.len()).collect();
    let mut current = vec![0; right_chars.len() + 1];

    for (i, left_ch) in left_chars.iter().enumerate() {
        current[0] = i + 1;
        for (j, right_ch) in right_chars.iter().enumerate() {
            let substitution = if left_ch == right_ch { 0 } else { 1 };
            current[j + 1] = (previous[j + 1] + 1)
                .min(current[j] + 1)
                .min(previous[j] + substitution);
        }
        std::mem::swap(&mut previous, &mut current);
    }

    previous[right_chars.len()]
}

#[cfg(test)]
mod tests;
