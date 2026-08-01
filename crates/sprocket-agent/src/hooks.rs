use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use rig::agent::{AgentHook, Flow, InvalidToolCallContext, StepEvent, StepEventKind};
use rig::completion::CompletionModel;

pub(crate) const AGENT_TOOL_NAMES: &[&str] = &[
    "apply_patch",
    "ask_question",
    "await_question",
    "browser_act",
    "browser_extract",
    "browser_observe",
    "create_artifact",
    "exec_command",
    "purchase_credential",
    "purchase_create_session",
    "purchase_report_status",
    "purchase_status",
    "read_skill",
    "scrape_url",
    "update_artifact",
    "web_search",
    "write_stdin",
];

#[derive(Clone, Debug)]
struct TrackedToolCall {
    call_id: Option<String>,
    name: String,
    args: serde_json::Value,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ToolCallTracker(Arc<Mutex<VecDeque<TrackedToolCall>>>);

impl ToolCallTracker {
    fn record(&self, call_id: Option<&str>, name: &str, args: &str) {
        let Ok(args) = serde_json::from_str(args) else {
            return;
        };
        if let Ok(mut calls) = self.0.lock() {
            calls.push_back(TrackedToolCall {
                call_id: call_id.map(str::to_owned),
                name: name.to_owned(),
                args,
            });
        }
    }

    pub(crate) fn claim(&self, name: &str, args: &serde_json::Value) -> Option<String> {
        let mut calls = self.0.lock().ok()?;
        let mut compatible = calls
            .iter()
            .enumerate()
            .filter(|(_, call)| call.name == name && tool_payload_compatible(&call.args, args));
        let (index, _) = compatible.next()?;
        if compatible.next().is_some() {
            return None;
        }
        calls.remove(index)?.call_id
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

#[derive(Clone)]
pub(crate) struct AgentPromptHook {
    tracker: ToolCallTracker,
}

impl AgentPromptHook {
    pub(crate) fn new(tracker: ToolCallTracker) -> Self {
        Self { tracker }
    }
}

impl<M> AgentHook<M> for AgentPromptHook
where
    M: CompletionModel,
{
    async fn on_event(&self, _context: &rig::agent::HookContext, event: StepEvent<'_, M>) -> Flow {
        match event {
            StepEvent::InvalidToolCall(context) => resolve_invalid_tool_call(context),
            StepEvent::ToolCall {
                tool_name,
                tool_call_id,
                args,
                ..
            } => {
                self.tracker.record(tool_call_id, tool_name, args);
                Flow::cont()
            }
            _ => Flow::cont(),
        }
    }

    fn observes(&self, kind: StepEventKind) -> bool {
        matches!(
            kind,
            StepEventKind::InvalidToolCall | StepEventKind::ToolCall
        )
    }
}

pub(crate) fn resolve_invalid_tool_call(context: &InvalidToolCallContext) -> Flow {
    resolve_invalid_tool_name(&context.tool_name, &context.available_tools)
}

fn resolve_invalid_tool_name(tool_name: &str, available_tools: &[String]) -> Flow {
    let candidates = if available_tools.is_empty() {
        AGENT_TOOL_NAMES
            .iter()
            .map(|name| (*name).to_string())
            .collect()
    } else {
        available_tools.to_vec()
    };

    if let Some(repaired) = repair_tool_name(tool_name, &candidates) {
        return Flow::repair(repaired);
    }

    Flow::retry(format!(
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

    #[test]
    fn repairs_near_miss_tool_names() {
        match resolve_invalid_tool_name("exec-command", &tools()) {
            Flow::Repair { tool_name } => {
                assert_eq!(tool_name, "exec_command");
            }
            other => panic!("expected repair, got {other:?}"),
        }

        match resolve_invalid_tool_name("apply-patch", &tools()) {
            Flow::Repair { tool_name } => {
                assert_eq!(tool_name, "apply_patch");
            }
            other => panic!("expected repair, got {other:?}"),
        }

        match resolve_invalid_tool_name("writestdin", &tools()) {
            Flow::Repair { tool_name } => {
                assert_eq!(tool_name, "write_stdin");
            }
            other => panic!("expected repair, got {other:?}"),
        }
    }

    #[test]
    fn retries_unknown_tool_names() {
        match resolve_invalid_tool_name("launch_missiles", &tools()) {
            Flow::Retry { feedback } => {
                assert!(feedback.contains("exec_command"));
                assert!(feedback.contains("write_stdin"));
                assert!(feedback.contains("apply_patch"));
            }
            other => panic!("expected retry, got {other:?}"),
        }
    }

    #[test]
    fn tracker_claims_only_the_matching_executed_call() {
        let tracker = ToolCallTracker::default();
        tracker.record(Some("call-1"), "exec_command", r#"{"cmd":"pwd"}"#);
        tracker.record(Some("call-2"), "exec_command", r#"{"cmd":"ls"}"#);

        assert_eq!(
            tracker.claim("exec_command", &serde_json::json!({ "cmd": "ls" })),
            Some("call-2".to_string())
        );
        assert_eq!(
            tracker.claim("exec_command", &serde_json::json!({ "cmd": "pwd" })),
            Some("call-1".to_string())
        );
    }

    #[test]
    fn tracker_uniquely_matches_normalized_args_when_typed_args_drop_fields() {
        let tracker = ToolCallTracker::default();
        tracker.record(
            Some("call-1"),
            "exec_command",
            r#"{"cmd":"pwd","workdir":null,"unknown":"ignored"}"#,
        );
        tracker.record(Some("call-2"), "exec_command", r#"{"cmd":"ls"}"#);

        assert_eq!(
            tracker.claim("exec_command", &serde_json::json!({ "cmd": "pwd" })),
            Some("call-1".to_string())
        );
        assert_eq!(
            tracker.claim("exec_command", &serde_json::json!({ "cmd": "ls" })),
            Some("call-2".to_string())
        );
    }

    #[test]
    fn tracker_does_not_claim_ambiguous_normalized_parallel_calls() {
        let tracker = ToolCallTracker::default();
        tracker.record(
            Some("call-1"),
            "exec_command",
            r#"{"cmd":"pwd","workdir":null}"#,
        );
        tracker.record(
            Some("call-2"),
            "exec_command",
            r#"{"cmd":"pwd","unknown":"first"}"#,
        );

        assert_eq!(
            tracker.claim("exec_command", &serde_json::json!({ "cmd": "pwd" })),
            None
        );
    }
}
