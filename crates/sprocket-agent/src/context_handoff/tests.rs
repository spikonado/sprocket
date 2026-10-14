use super::*;

#[test]
fn counts_provider_totals_without_counting_cache_or_reasoning_twice() {
    assert_eq!(
        context_tokens(
            Usage::new()
                .input_tokens(100)
                .output_tokens(30)
                .cached_input_tokens(80)
                .reasoning_tokens(20)
        ),
        Some(130)
    );
}

#[test]
fn missing_usage_preserves_the_last_observation_until_restart() {
    let hook = ContextHandoffHook::new(100, 120, true);
    assert_eq!(hook.record_usage(Usage::default()), None);
    assert_eq!(hook.state.lock().unwrap().context_tokens, 120);
    hook.restart();
    assert_eq!(hook.state.lock().unwrap().context_tokens, 0);
}

#[test]
fn partial_usage_preserves_context_without_persisting_an_incomplete_total() {
    let hook = ContextHandoffHook::new(100, 120, true);
    assert_eq!(hook.record_usage(Usage::new().output_tokens(30)), None);
    assert_eq!(hook.state.lock().unwrap().context_tokens, 120);
}

#[test]
fn reported_total_updates_context_without_individual_counters() {
    let hook = ContextHandoffHook::new(100, 120, true);
    assert_eq!(hook.record_usage(Usage::new().total_tokens(150)), Some(150));
    assert_eq!(hook.state.lock().unwrap().context_tokens, 150);
}

#[test]
fn reported_zero_replaces_the_last_context_observation() {
    let hook = ContextHandoffHook::new(100, 120, true);
    assert_eq!(
        hook.record_usage(Usage::new().input_tokens(0).output_tokens(0)),
        Some(0)
    );
    assert_eq!(hook.state.lock().unwrap().context_tokens, 0);
}

#[test]
fn defers_the_new_prompt_without_putting_it_in_the_handoff_history() {
    let history = vec![Message::user("old work")];
    let prompt = Message::user("new task");
    let mut state = HandoffState {
        context_tokens: 100,
        first_call: true,
        defer_prompt: true,
        ..Default::default()
    };
    assert!(matches!(
        state.prepare(
            CompletionCallEvent {
                history: &history,
                prompt: &prompt,
                turn: 1
            },
            100,
        ),
        CompletionCallAction::Stop(_)
    ));
    let request = state.request.unwrap();
    assert_eq!(request.history, history);
    assert_eq!(request.deferred_prompt, Some(prompt));
    assert!(request.before_prompt);
}

#[test]
fn mid_run_handoff_includes_the_pending_tool_result() {
    let history = vec![Message::user("old work")];
    let prompt = Message::user("tool result");
    let mut state = HandoffState {
        context_tokens: 100,
        ..Default::default()
    };
    state.prepare(
        CompletionCallEvent {
            history: &history,
            prompt: &prompt,
            turn: 2,
        },
        100,
    );
    let request = state.request.unwrap();
    assert_eq!(request.history, vec![history[0].clone(), prompt]);
    assert!(request.deferred_prompt.is_none());
    assert!(!request.before_prompt);
}

#[test]
fn does_not_estimate_tokens_from_large_messages() {
    let history = vec![Message::user("x".repeat(100_000))];
    let prompt = Message::user("next");
    let mut state = HandoffState::default();
    assert!(matches!(
        state.prepare(
            CompletionCallEvent {
                history: &history,
                prompt: &prompt,
                turn: 1
            },
            100,
        ),
        CompletionCallAction::Continue
    ));
    assert!(state.request.is_none());
}

#[test]
fn handoff_submission_requires_a_pending_request_and_nonempty_document() {
    let mut state = HandoffState::default();
    assert!(state.submit("handoff".into()).is_err());
    state.writing = true;
    assert!(state.submit("  ".into()).is_err());
    assert!(state.submit("handoff".into()).is_ok());
    assert!(state.submit("duplicate".into()).is_err());
    assert_eq!(state.summary.as_deref(), Some("handoff"));
}
