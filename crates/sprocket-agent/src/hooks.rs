use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use rig::agent::{
    AgentHook, HookContext, InvalidToolCallAction, InvalidToolCallContext, ModelTurnAction,
    ModelTurnFinished, StepEventKind, ToolCallAction,
};
use rig::message::AssistantContent;
use serde::Serialize;
use sha2::{Digest, Sha256};

pub(crate) const AGENT_TOOL_NAMES: &[&str] = &[
    "add_artifact",
    "apply_patch",
    "ask_question",
    "await_question",
    "browser_interact",
    "browser_screenshot",
    "edit_artifact",
    "exec_command",
    "list_artifacts",
    "mandate_charge",
    "mandate_list",
    "mandate_report",
    "mandate_setup",
    "mandate_status",
    "parse_file",
    "read_skill",
    "save_artifact",
    "scrape_url",
    "screenshot_url",
    "web_search",
    "write_stdin",
];

pub(crate) fn available_agent_tool_names(
    allow_interaction: bool,
    supports_images: bool,
) -> Vec<&'static str> {
    AGENT_TOOL_NAMES
        .iter()
        .copied()
        .filter(|name| {
            (allow_interaction
                || !matches!(*name, "ask_question" | "await_question" | "mandate_setup"))
                && (supports_images || *name != "screenshot_url")
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkRangeAssignment {
    pub(crate) start: u64,
    pub(crate) end: u64,
    pub(crate) section_key: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolInvocationAssignment {
    pub(crate) call_id: String,
    pub(crate) tool_invocation_id: String,
    pub(crate) section_key: String,
    #[serde(skip)]
    pub(crate) section_ordinal: u64,
    #[serde(skip)]
    pub(crate) attempt_seq: u64,
    #[serde(skip)]
    pub(crate) stream_id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompletionAssignments {
    pub(crate) work: CompletionWorkAssignments,
    pub(crate) tool_invocations: Vec<ToolInvocationAssignment>,
    pub(crate) sections: Vec<SectionAssignment>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub(crate) struct CompletionWorkAssignments {
    pub(crate) ranges: Vec<WorkRangeAssignment>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SectionAssignment {
    pub(crate) section_key: String,
    pub(crate) section_ordinal: u64,
    pub(crate) closed: bool,
}

#[derive(Clone, Debug, PartialEq)]
enum OrderedContent {
    Text(bool),
    Reasoning(bool),
    Tool {
        model_call_id: String,
        call_id: String,
    },
    Other,
}

#[derive(Debug)]
struct ToolCallState {
    run_id: String,
    claim_id: String,
    attempt_seq: u64,
    stream_id: String,
    next_section_ordinal: u64,
    open_section: Option<SectionAssignment>,
    streamed_internal_ids: HashMap<String, VecDeque<String>>,
    invocations_by_internal_id: HashMap<String, ToolInvocationAssignment>,
    unbound_invocations: HashMap<String, VecDeque<ToolInvocationAssignment>>,
    dispatches_by_tool: HashMap<String, VecDeque<PendingDispatch>>,
    completion: CompletionAssignments,
}

#[derive(Debug)]
struct PendingDispatch {
    args: serde_json::Value,
    assignment: ToolInvocationAssignment,
}

#[derive(Clone, Debug)]
pub(crate) struct ToolCallTracker(Arc<Mutex<ToolCallState>>);

impl ToolCallTracker {
    pub(crate) fn new(run_id: &str, claim_id: &str) -> Self {
        Self(Arc::new(Mutex::new(ToolCallState {
            run_id: run_id.to_owned(),
            claim_id: claim_id.to_owned(),
            attempt_seq: 1,
            stream_id: format!("agent:{run_id}:{claim_id}:1"),
            next_section_ordinal: 1,
            open_section: None,
            streamed_internal_ids: HashMap::new(),
            invocations_by_internal_id: HashMap::new(),
            unbound_invocations: HashMap::new(),
            dispatches_by_tool: HashMap::new(),
            completion: CompletionAssignments::default(),
        })))
    }

    pub(crate) fn begin_attempt(&self, attempt_seq: u64, stream_id: &str) {
        if let Ok(mut state) = self.0.lock() {
            state.attempt_seq = attempt_seq;
            state.stream_id = stream_id.to_owned();
            state.streamed_internal_ids.clear();
            state.invocations_by_internal_id.clear();
            state.unbound_invocations.clear();
            state.dispatches_by_tool.clear();
            state.completion = CompletionAssignments::default();
        }
    }

    pub(crate) fn observe_streamed_call(&self, model_call_id: &str, internal_call_id: &str) {
        if let Ok(mut state) = self.0.lock() {
            state
                .streamed_internal_ids
                .entry(model_call_id.to_owned())
                .or_default()
                .push_back(internal_call_id.to_owned());
        }
    }

    pub(crate) fn completion_assignments(&self) -> CompletionAssignments {
        self.0
            .lock()
            .map(|state| state.completion.clone())
            .unwrap_or_default()
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
        let mut state = self.0.lock().ok()?;
        let pending = state.dispatches_by_tool.get_mut(tool_name)?;
        let index = pending
            .iter()
            .position(|dispatch| tool_payload_compatible(&dispatch.args, args))?;
        pending.remove(index).map(|dispatch| dispatch.assignment)
    }

    fn record_turn(&self, content: &[OrderedContent]) {
        let Ok(mut state) = self.0.lock() else {
            return;
        };
        state.completion = CompletionAssignments::default();
        let mut touched_sections = Vec::new();
        for (index, item) in content.iter().enumerate() {
            match item {
                OrderedContent::Text(true) => {
                    if let Some(section) = state.open_section.take() {
                        touched_sections.push(section);
                    }
                }
                OrderedContent::Reasoning(true) => {
                    let section = ensure_section(&mut state);
                    touched_sections.push(section.clone());
                    push_range(
                        &mut state.completion.work.ranges,
                        index as u64,
                        &section.section_key,
                    );
                }
                OrderedContent::Tool {
                    model_call_id,
                    call_id,
                } => {
                    let section = ensure_section(&mut state);
                    touched_sections.push(section.clone());
                    push_range(
                        &mut state.completion.work.ranges,
                        index as u64,
                        &section.section_key,
                    );
                    let assignment = ToolInvocationAssignment {
                        call_id: call_id.clone(),
                        tool_invocation_id: stable_id(
                            "invocation",
                            &state.run_id,
                            &state.claim_id,
                            state.attempt_seq,
                            index as u64,
                        ),
                        section_key: section.section_key,
                        section_ordinal: section.section_ordinal,
                        attempt_seq: state.attempt_seq,
                        stream_id: state.stream_id.clone(),
                    };
                    let internal_id = state
                        .streamed_internal_ids
                        .get_mut(model_call_id)
                        .and_then(VecDeque::pop_front);
                    if let Some(internal_id) = internal_id {
                        state
                            .invocations_by_internal_id
                            .insert(internal_id, assignment.clone());
                    } else {
                        state
                            .unbound_invocations
                            .entry(call_id.clone())
                            .or_default()
                            .push_back(assignment.clone());
                    }
                    state.completion.tool_invocations.push(assignment);
                }
                OrderedContent::Text(false)
                | OrderedContent::Reasoning(false)
                | OrderedContent::Other => {}
            }
        }
        touched_sections.sort_by_key(|section| section.section_ordinal);
        touched_sections.dedup_by(|left, right| left.section_key == right.section_key);
        for section in &mut touched_sections {
            section.closed = state
                .open_section
                .as_ref()
                .is_none_or(|open| open.section_key != section.section_key);
        }
        state.completion.sections = touched_sections;
    }
}

fn ensure_section(state: &mut ToolCallState) -> SectionAssignment {
    if let Some(section) = &state.open_section {
        return section.clone();
    }
    let section_ordinal = state.next_section_ordinal;
    state.next_section_ordinal += 1;
    let section = SectionAssignment {
        section_key: format!(
            "agent:{}:{}:{}:section:{section_ordinal}",
            state.run_id, state.claim_id, state.attempt_seq
        ),
        section_ordinal,
        closed: false,
    };
    state.open_section = Some(section.clone());
    section
}

fn push_range(ranges: &mut Vec<WorkRangeAssignment>, index: u64, section_key: &str) {
    if let Some(last) = ranges
        .last_mut()
        .filter(|range| range.end == index && range.section_key == section_key)
    {
        last.end += 1;
    } else {
        ranges.push(WorkRangeAssignment {
            start: index,
            end: index + 1,
            section_key: section_key.to_owned(),
        });
    }
}

fn stable_id(kind: &str, run_id: &str, claim_id: &str, attempt_seq: u64, index: u64) -> String {
    let mut hash = Sha256::new();
    for value in [
        kind,
        run_id,
        claim_id,
        &attempt_seq.to_string(),
        &index.to_string(),
    ] {
        hash.update((value.len() as u64).to_le_bytes());
        hash.update(value.as_bytes());
    }
    format!("agent-{kind}-{}", hex::encode(hash.finalize()))
}

fn ordered_content(content: &[AssistantContent]) -> Vec<OrderedContent> {
    content
        .iter()
        .map(|item| match item {
            AssistantContent::Text(text) => OrderedContent::Text(!text.text.trim().is_empty()),
            AssistantContent::Reasoning(reasoning) => {
                // Must match what is persisted: summary blocks only. `display_text`
                // also joins Text/Redacted, which never become transcript text.
                // Empty (encrypted-only) reasoning is stored for replay but carries
                // no work assignment; the server rejects work covering it.
                OrderedContent::Reasoning(
                    !crate::reasoning::reasoning_summary_text(reasoning)
                        .trim()
                        .is_empty(),
                )
            }
            AssistantContent::ToolCall(call) => OrderedContent::Tool {
                model_call_id: call.id.as_str().to_owned(),
                call_id: call.wire_call_id().to_owned(),
            },
            _ => OrderedContent::Other,
        })
        .collect()
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
    async fn on_tool_call(
        &self,
        _context: &HookContext,
        event: rig::agent::ToolCall<'_>,
    ) -> ToolCallAction {
        if AGENT_TOOL_NAMES.contains(&event.tool_name) {
            self.tracker.prepare_dispatch(
                event.tool_name,
                event.internal_call_id,
                event.tool_call_id,
                event.args,
            );
        }
        ToolCallAction::Run
    }

    async fn on_model_turn_finished(
        &self,
        _context: &HookContext,
        event: ModelTurnFinished<'_>,
    ) -> ModelTurnAction {
        self.tracker.record_turn(&ordered_content(event.content));
        ModelTurnAction::Continue
    }

    async fn on_invalid_tool_call(
        &self,
        _context: &HookContext,
        event: &InvalidToolCallContext,
    ) -> Option<InvalidToolCallAction> {
        Some(resolve_invalid_tool_call(event))
    }

    fn observes(&self, kind: StepEventKind) -> bool {
        matches!(
            kind,
            StepEventKind::InvalidToolCall
                | StepEventKind::ToolCall
                | StepEventKind::ModelTurnFinished
        )
    }
}

fn tool_payload_compatible(raw: &serde_json::Value, normalized: &serde_json::Value) -> bool {
    match (raw, normalized) {
        (serde_json::Value::Object(raw), serde_json::Value::Object(normalized)) => {
            normalized.iter().all(|(key, value)| {
                raw.get(key)
                    .is_some_and(|raw| tool_payload_compatible(raw, value))
            })
        }
        (serde_json::Value::Array(raw), serde_json::Value::Array(normalized)) => {
            raw.len() == normalized.len()
                && raw
                    .iter()
                    .zip(normalized)
                    .all(|(raw, normalized)| tool_payload_compatible(raw, normalized))
        }
        _ => raw == normalized,
    }
}

pub(crate) fn resolve_invalid_tool_call(context: &InvalidToolCallContext) -> InvalidToolCallAction {
    resolve_invalid_tool_name(&context.tool_name, &context.available_tools)
}

fn resolve_invalid_tool_name(tool_name: &str, available_tools: &[String]) -> InvalidToolCallAction {
    let candidates = if available_tools.is_empty() {
        AGENT_TOOL_NAMES
            .iter()
            .map(|name| (*name).to_string())
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
mod tests {
    use super::*;

    fn tools() -> Vec<String> {
        AGENT_TOOL_NAMES
            .iter()
            .map(|name| (*name).to_string())
            .collect()
    }

    fn assert_repaired(tool_name: &str, expected: &str) {
        match resolve_invalid_tool_name(tool_name, &tools()) {
            InvalidToolCallAction::Repair { tool_name } => assert_eq!(tool_name, expected),
            other => panic!("expected repair, got {other:?}"),
        }
    }

    #[test]
    fn repairs_near_miss_tool_names() {
        assert_repaired("exec-command", "exec_command");
        assert_repaired("apply-patch", "apply_patch");
        assert_repaired("writestdin", "write_stdin");
        assert_repaired("parse-file", "parse_file");
    }

    #[test]
    fn available_tools_match_run_capabilities() {
        let cli = available_agent_tool_names(false, false);
        assert!(!cli.contains(&"ask_question"));
        assert!(!cli.contains(&"await_question"));
        assert!(!cli.contains(&"mandate_setup"));
        assert!(!cli.contains(&"screenshot_url"));
        assert!(cli.contains(&"exec_command"));

        assert_eq!(available_agent_tool_names(true, true), AGENT_TOOL_NAMES);
    }

    #[test]
    fn retries_unknown_tool_names() {
        match resolve_invalid_tool_name("launch_missiles", &tools()) {
            InvalidToolCallAction::Retry { feedback } => {
                assert!(feedback.contains("exec_command"));
                assert!(feedback.contains("write_stdin"));
                assert!(feedback.contains("apply_patch"));
            }
            other => panic!("expected retry, got {other:?}"),
        }
    }

    #[test]
    fn tracker_associates_identical_parallel_calls_by_internal_identity() {
        let tracker = ToolCallTracker::new("run", "claim");
        tracker.observe_streamed_call("model-1", "internal-1");
        tracker.observe_streamed_call("model-2", "internal-2");
        tracker.record_turn(&[
            OrderedContent::Tool {
                model_call_id: "model-1".into(),
                call_id: "call-1".into(),
            },
            OrderedContent::Tool {
                model_call_id: "model-2".into(),
                call_id: "call-2".into(),
            },
        ]);

        let second = tracker
            .assignment_for_dispatch("internal-2", Some("call-2"))
            .unwrap();
        let first = tracker
            .assignment_for_dispatch("internal-1", Some("call-1"))
            .unwrap();
        assert_eq!(second.call_id, "call-2");
        assert_eq!(first.call_id, "call-1");
        assert_ne!(first.tool_invocation_id, second.tool_invocation_id);
        assert_eq!(first.section_key, second.section_key);

        tracker.prepare_dispatch(
            "exec_command",
            "internal-1",
            Some("call-1"),
            r#"{"cmd":"first"}"#,
        );
        tracker.prepare_dispatch(
            "exec_command",
            "internal-2",
            Some("call-2"),
            r#"{"cmd":"second"}"#,
        );
        let second_dispatch = tracker
            .claim_dispatch("exec_command", &serde_json::json!({"cmd":"second"}))
            .unwrap();
        let first_dispatch = tracker
            .claim_dispatch("exec_command", &serde_json::json!({"cmd":"first"}))
            .unwrap();
        assert_eq!(second_dispatch.call_id, "call-2");
        assert_eq!(first_dispatch.call_id, "call-1");

        let original_ids = tracker
            .completion_assignments()
            .tool_invocations
            .into_iter()
            .map(|invocation| invocation.tool_invocation_id)
            .collect::<Vec<_>>();
        tracker.record_turn(&[
            OrderedContent::Tool {
                model_call_id: "model-1".into(),
                call_id: "call-1".into(),
            },
            OrderedContent::Tool {
                model_call_id: "model-2".into(),
                call_id: "call-2".into(),
            },
        ]);
        let retry_ids = tracker
            .completion_assignments()
            .tool_invocations
            .into_iter()
            .map(|invocation| invocation.tool_invocation_id)
            .collect::<Vec<_>>();
        assert_eq!(retry_ids, original_ids);
    }

    #[test]
    fn grouping_survives_turns_and_text_closes_the_current_section() {
        let tracker = ToolCallTracker::new("run", "claim");
        tracker.record_turn(&[
            OrderedContent::Reasoning(true),
            OrderedContent::Tool {
                model_call_id: "one".into(),
                call_id: "one".into(),
            },
        ]);
        let first = tracker.completion_assignments();
        let first_key = first.work.ranges[0].section_key.clone();
        assert_eq!(first.work.ranges[0].start, 0);
        assert_eq!(first.work.ranges[0].end, 2);

        tracker.begin_attempt(2, "stream-2");
        tracker.record_turn(&[
            OrderedContent::Reasoning(true),
            OrderedContent::Text(true),
            OrderedContent::Reasoning(true),
            OrderedContent::Tool {
                model_call_id: "two".into(),
                call_id: "two".into(),
            },
        ]);
        let second = tracker.completion_assignments();
        assert_eq!(second.work.ranges[0].section_key, first_key);
        assert_ne!(second.work.ranges[1].section_key, first_key);
        assert!(second.sections[0].closed);
        assert!(!second.sections[1].closed);
        assert_eq!(second.work.ranges[1].end, 4);
        assert_eq!(
            second.tool_invocations[0].section_key,
            second.work.ranges[1].section_key
        );
    }

    #[test]
    fn non_summary_reasoning_blocks_carry_no_work() {
        use rig::message::{AssistantContent, Reasoning, ReasoningContent};

        // Summary text is what gets persisted, so only it counts as work.
        // Text/Redacted never become transcript text; Encrypted is replay-only.
        let summary = ordered_content(&[AssistantContent::Reasoning(Reasoning {
            id: Some("rs_1".into()),
            content: vec![ReasoningContent::Summary("plan".into())],
        })]);
        assert_eq!(summary, vec![OrderedContent::Reasoning(true)]);

        for content in [
            vec![ReasoningContent::Encrypted("envelope".into())],
            vec![ReasoningContent::Text {
                text: "raw".into(),
                signature: None,
            }],
            vec![ReasoningContent::Redacted {
                data: "redacted".into(),
            }],
            vec![ReasoningContent::Summary("  \n ".into())],
        ] {
            let mapped = ordered_content(&[AssistantContent::Reasoning(Reasoning {
                id: Some("rs_1".into()),
                content,
            })]);
            assert_eq!(mapped, vec![OrderedContent::Reasoning(false)]);
        }
    }
}
