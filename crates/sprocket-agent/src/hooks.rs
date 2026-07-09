use std::sync::{Arc, Mutex};

use rig::agent::{
    HookAction, InvalidToolCallContext, InvalidToolCallHookAction, PromptHook, ToolCallHookAction,
};
use rig::completion::CompletionModel;

use crate::convex::RuntimeClient;

pub(crate) const WORKSPACE_TOOL_NAMES: &[&str] =
    &["exec_command", "create_file", "replace_in_file"];

#[derive(Clone)]
pub(crate) struct AgentPromptHook {
    runtime: RuntimeClient,
    run_id: String,
    aggregated_text: Arc<Mutex<String>>,
}

impl AgentPromptHook {
    pub(crate) fn new(
        runtime: RuntimeClient,
        run_id: String,
        aggregated_text: Arc<Mutex<String>>,
    ) -> Self {
        Self {
            runtime,
            run_id,
            aggregated_text,
        }
    }
}

impl<M> PromptHook<M> for AgentPromptHook
where
    M: CompletionModel,
{
    async fn on_text_delta(&self, _text_delta: &str, aggregated_text: &str) -> HookAction {
        if let Ok(mut guard) = self.aggregated_text.lock() {
            *guard = aggregated_text.to_string();
        }

        match self
            .runtime
            .update_assistant_message(&self.run_id, aggregated_text)
            .await
        {
            Ok(()) => HookAction::cont(),
            Err(error) => HookAction::terminate(error.to_string()),
        }
    }

    async fn on_invalid_tool_call(
        &self,
        context: &InvalidToolCallContext,
    ) -> InvalidToolCallHookAction {
        resolve_invalid_tool_call(context)
    }

    async fn on_tool_call(
        &self,
        _tool_name: &str,
        _tool_call_id: Option<String>,
        _internal_call_id: &str,
        _args: &str,
    ) -> ToolCallHookAction {
        ToolCallHookAction::cont()
    }
}

pub(crate) fn resolve_invalid_tool_call(
    context: &InvalidToolCallContext,
) -> InvalidToolCallHookAction {
    let candidates = if context.available_tools.is_empty() {
        WORKSPACE_TOOL_NAMES
            .iter()
            .map(|name| (*name).to_string())
            .collect()
    } else {
        context.available_tools.clone()
    };

    if let Some(repaired) = repair_tool_name(&context.tool_name, &candidates) {
        return InvalidToolCallHookAction::repair(repaired);
    }

    InvalidToolCallHookAction::retry(format!(
        "Unknown or disallowed tool `{}`. Use one of: {}.",
        context.tool_name,
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
    use rig::agent::InvalidToolCallContext;

    fn context(tool_name: &str) -> InvalidToolCallContext {
        InvalidToolCallContext {
            tool_name: tool_name.to_string(),
            tool_call_id: None,
            internal_call_id: None,
            args: None,
            available_tools: WORKSPACE_TOOL_NAMES
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
            allowed_tools: WORKSPACE_TOOL_NAMES
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
            tool_choice: None,
            chat_history: Vec::new(),
            is_streaming: true,
        }
    }

    #[test]
    fn repairs_near_miss_tool_names() {
        match resolve_invalid_tool_call(&context("exec-command")) {
            InvalidToolCallHookAction::Repair { tool_name } => {
                assert_eq!(tool_name, "exec_command");
            }
            other => panic!("expected repair, got {other:?}"),
        }

        match resolve_invalid_tool_call(&context("createfile")) {
            InvalidToolCallHookAction::Repair { tool_name } => {
                assert_eq!(tool_name, "create_file");
            }
            other => panic!("expected repair, got {other:?}"),
        }
    }

    #[test]
    fn retries_unknown_tool_names() {
        match resolve_invalid_tool_call(&context("launch_missiles")) {
            InvalidToolCallHookAction::Retry { feedback } => {
                assert!(feedback.contains("exec_command"));
                assert!(feedback.contains("create_file"));
                assert!(feedback.contains("replace_in_file"));
            }
            other => panic!("expected retry, got {other:?}"),
        }
    }
}
