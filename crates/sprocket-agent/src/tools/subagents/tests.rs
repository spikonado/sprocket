use super::*;
use sprocket_transcript::RemoteTranscriptState;

#[test]
fn spawn_accepts_only_creation_payloads() {
    let args: SpawnSubagentArgs =
        serde_json::from_value(json!({"prompt": "  implement the task  ", "yieldTimeMs": 0}))
            .unwrap();
    assert_eq!(
        prepare_subagent_prompt(&args.prompt).unwrap(),
        "implement the task"
    );
    assert_eq!(args.yield_time_ms, 0);
    let error = serde_json::from_value::<SpawnSubagentArgs>(json!({
        "threadId": "child-thread",
        "prompt": "implement the next task"
    }))
    .unwrap_err();
    assert!(error.to_string().contains("unknown field `threadId`"));
}

#[test]
fn spawn_schema_only_advertises_child_creation() {
    let schema = spawn_subagent_parameters(270_000);
    assert!(schema["properties"].get("threadId").is_none());
    assert_eq!(schema["additionalProperties"], false);
}

#[test]
fn control_sends_followups_with_execution_overrides() {
    let args: ControlSubagentArgs = serde_json::from_value(json!({
        "action": "send",
        "threadId": "child-thread",
        "prompt": "  implement the next task  ",
        "model": "gpt-6.1-sol",
        "reasoning": "high",
        "fast": true,
        "timeoutMs": 60_000,
        "yieldTimeMs": 0
    }))
    .unwrap();
    validate_control(&args).unwrap();
    assert_eq!(
        prepare_subagent_prompt(args.prompt.as_deref().unwrap()).unwrap(),
        "implement the next task"
    );
    assert_eq!(args.thread_id, "child-thread");
    assert_eq!(args.timeout_ms, Some(60_000));
    assert_eq!(args.yield_time_ms, 0);
}

#[test]
fn creation_requires_an_explicit_task() {
    for payload in [json!({}), json!({"prompt": "  "})] {
        let result = serde_json::from_value::<SpawnSubagentArgs>(payload)
            .map_err(|error| tool_failure(error.to_string()))
            .and_then(|args| prepare_subagent_prompt(&args.prompt).map(|_| ()));
        assert!(result.unwrap_err().to_string().contains("prompt"));
    }
}

#[test]
fn control_fields_and_execution_options_are_action_specific() {
    for payload in [
        json!({"action": "send", "threadId": "child"}),
        json!({"action": "send", "threadId": "child", "prompt": " "}),
        json!({"action": "send", "threadId": "child", "prompt": "task", "questionId": "q"}),
        json!({"action": "send", "threadId": "child", "prompt": "task", "text": "answer"}),
        json!({"action": "stop"}),
        json!({"action": "stop", "threadId": " "}),
        json!({"action": "stop", "threadId": "child", "prompt": "task"}),
        json!({"action": "stop", "threadId": "child", "timeoutMs": 10}),
        json!({"action": "stop", "threadId": "child", "questionId": "question"}),
        json!({"action": "answer_question", "threadId": "child", "text": "answer"}),
        json!({"action": "answer_question", "threadId": "child", "questionId": "q"}),
        json!({"action": "answer_question", "threadId": "child", "questionId": "q", "text": "answer", "fast": false}),
    ] {
        let result = serde_json::from_value::<ControlSubagentArgs>(payload.clone())
            .map_err(|error| tool_failure(error.to_string()))
            .and_then(|args| validate_control(&args));
        assert!(result.is_err(), "{payload}");
    }
}

fn monitor_info(active: bool) -> SubagentMonitorInfo {
    SubagentMonitorInfo {
        status: if active { "running" } else { "completed" }.to_string(),
        last_error: None,
        active,
        pending_questions: Vec::new(),
        transcript: RemoteTranscriptState {
            thread_id: "child".to_string(),
            total_parts: 0,
            history_from_number: 0,
            context_summary: None,
            reasoning_stripped_through_part_number: None,
        },
    }
}

#[tokio::test]
async fn immediate_actions_return_lifecycle_without_reading_transcripts() {
    let result = subagent_action_result(
        monitor_info(true),
        0,
        &WorkspaceCancellation::new(),
        |_| async { panic!("immediate actions do not read transcripts") },
    )
    .await
    .unwrap();
    assert_eq!(
        result,
        json!({"status": "running", "lastError": null, "pendingQuestions": []})
    );
}

#[tokio::test(start_paused = true)]
async fn stop_waits_for_the_target_run_to_finish_even_with_pending_questions() {
    let started = Instant::now();
    let mut reads = 0;
    let info = wait_for_stopped_run_using(&WorkspaceCancellation::new(), || {
        reads += 1;
        let mut info = monitor_info(true);
        info.pending_questions
            .push(crate::subagents::SubagentQuestion {
                question_id: "question".to_string(),
                question: "Continue?".to_string(),
                options: Vec::new(),
            });
        if reads == 3 {
            info.status = "cancelled".to_string();
        }
        async move { Ok(info) }
    })
    .await
    .unwrap();
    assert_eq!(reads, 3);
    assert_eq!(started.elapsed(), WAIT_POLL_INTERVAL * 2);
    assert_eq!(
        subagent_metadata(&info),
        json!({
            "status": "cancelled", "lastError": null,
            "pendingQuestions": [{"questionId": "question", "question": "Continue?", "options": []}]
        })
    );
}

#[tokio::test]
async fn cancellation_aborts_a_stalled_stop_observation() {
    let cancellation = WorkspaceCancellation::new();
    let cancel = cancellation.clone();
    let error = wait_for_stopped_run_using(&cancellation, || {
        cancel.cancel();
        std::future::pending::<anyhow::Result<SubagentMonitorInfo>>()
    })
    .await
    .unwrap_err();
    assert_eq!(error.kind(), rig::tool::ToolErrorKind::Cancelled);
}

#[tokio::test(start_paused = true)]
async fn settlement_waits_until_completion_and_returns_the_last_snapshot() {
    let started = Instant::now();
    let mut reads = 0;
    let info = wait_for_settlement_using(10_000, &WorkspaceCancellation::new(), || {
        reads += 1;
        let mut info = monitor_info(reads < 3);
        info.last_error = Some(format!("snapshot-{reads}"));
        async move { Ok(info) }
    })
    .await
    .unwrap();
    assert_eq!(started.elapsed(), WAIT_POLL_INTERVAL * 2);
    assert_eq!(reads, 3);
    assert_eq!(info.status, "completed");
    assert_eq!(info.last_error.as_deref(), Some("snapshot-3"));
}

#[tokio::test(start_paused = true)]
async fn settlement_returns_a_pending_question_without_waiting_for_completion() {
    let started = Instant::now();
    let mut reads = 0;
    let info = wait_for_settlement_using(10_000, &WorkspaceCancellation::new(), || {
        reads += 1;
        let mut info = monitor_info(true);
        if reads == 2 {
            info.pending_questions
                .push(crate::subagents::SubagentQuestion {
                    question_id: "question".to_string(),
                    question: "Which direction?".to_string(),
                    options: Vec::new(),
                });
        }
        async move { Ok(info) }
    })
    .await
    .unwrap();
    assert_eq!(started.elapsed(), WAIT_POLL_INTERVAL);
    assert!(info.active);
    assert_eq!(info.pending_questions[0].question_id, "question");
}

#[tokio::test]
async fn cancellation_aborts_a_stalled_post_launch_observation() {
    let cancellation = WorkspaceCancellation::new();
    let cancel = cancellation.clone();
    let result = wait_for_settlement_using(10_000, &cancellation, || {
        let cancel = cancel.clone();
        async move {
            cancel.cancel();
            std::future::pending::<Result<SubagentMonitorInfo, ToolExecutionError>>().await
        }
    })
    .await
    .unwrap_err();
    assert_eq!(result.kind(), rig::tool::ToolErrorKind::Cancelled);
}

#[tokio::test]
async fn cancellation_aborts_a_stalled_transcript_read() {
    let cancellation = WorkspaceCancellation::new();
    let cancel = cancellation.clone();
    let result = subagent_action_result(monitor_info(false), 10_000, &cancellation, |_| async {
        cancel.cancel();
        std::future::pending::<Result<serde_json::Value, ToolExecutionError>>().await
    })
    .await
    .unwrap_err();
    assert_eq!(result.kind(), rig::tool::ToolErrorKind::Cancelled);
}

#[tokio::test(start_paused = true)]
async fn immediate_polls_share_a_thread_cooldown_and_terminal_reads_stay_available() {
    let polls = SubagentPolls::default();
    let observe = |info: SubagentMonitorInfo| async move { Ok(json!({"status": info.status})) };
    polls
        .observe_pending("child", || async { Ok(monitor_info(true)) }, observe)
        .await
        .unwrap();
    let error = polls
        .clone()
        .observe_pending(
            "child",
            || async { Ok(monitor_info(true)) },
            |_| async { panic!("cooldown must be checked before reading output") },
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("Check again after"));
    let completed = polls
        .observe_pending("child", || async { Ok(monitor_info(false)) }, observe)
        .await
        .unwrap();
    assert_eq!(completed["status"], "completed");
    polls
        .observe_pending(
            "another-child",
            || async { Ok(monitor_info(true)) },
            observe,
        )
        .await
        .unwrap();
    tokio::time::advance(Duration::from_secs(10)).await;
    polls
        .observe_pending("child", || async { Ok(monitor_info(true)) }, observe)
        .await
        .unwrap();
}

#[tokio::test]
async fn unsuccessful_output_reads_leave_immediate_poll_available() {
    let polls = SubagentPolls::default();
    polls
        .observe_pending(
            "child",
            || async { Ok(monitor_info(true)) },
            |_| async { Err(tool_failure("transcript unavailable")) },
        )
        .await
        .unwrap_err();
    let result = polls
        .observe_pending(
            "child",
            || async { Ok(monitor_info(true)) },
            |_| async { Ok(json!({"entries": ["output"]})) },
        )
        .await
        .unwrap();
    assert_eq!(result["entries"], json!(["output"]));
}

#[tokio::test(start_paused = true)]
async fn timed_out_creation_recovers_the_committed_child() {
    let committed = std::cell::Cell::new(None);
    let child = submit_or_recover(
        async {
            committed.set(Some(("child-thread", "child-run")));
            std::future::pending::<Result<(&str, &str), MutationFailure>>().await
        },
        async { Ok(committed.get()) },
    )
    .await
    .unwrap();
    assert_eq!(child, ("child-thread", "child-run"));
}

#[tokio::test]
async fn lost_creation_response_recovers_the_committed_child() {
    let committed = std::cell::Cell::new(None);
    let child = submit_or_recover(
        async {
            committed.set(Some("child-run"));
            Err(MutationFailure::Transport(anyhow::anyhow!(
                "connection closed after commit"
            )))
        },
        async { Ok(committed.get()) },
    )
    .await
    .unwrap();
    assert_eq!(child, "child-run");
}

#[tokio::test]
async fn uncommitted_creation_preserves_the_transport_failure() {
    let error = submit_or_recover::<()>(
        async {
            Err(MutationFailure::Transport(anyhow::anyhow!(
                "connection closed"
            )))
        },
        async { Ok(None) },
    )
    .await
    .unwrap_err();
    assert_eq!(error.to_string(), "connection closed");
}

#[tokio::test]
async fn functional_creation_errors_do_not_issue_a_recovery_lookup() {
    let error = submit_or_recover::<()>(
        async {
            Err(MutationFailure::Functional(anyhow::anyhow!(
                "SPROCKET_SUBMISSION_WAITING"
            )))
        },
        async { panic!("a rejected creation needs no reconciliation") },
    )
    .await
    .unwrap_err();
    assert!(submission_is_waiting(&error));
}

#[tokio::test]
async fn successful_creation_does_not_issue_a_recovery_lookup() {
    let child = submit_or_recover(async { Ok("child-run") }, async {
        panic!("successful creation needs no reconciliation")
    })
    .await
    .unwrap();
    assert_eq!(child, "child-run");
}

#[test]
fn child_secret_is_keyed_stable_and_never_the_caller_secret() {
    let caller_secret = uuid::Uuid::new_v4().to_string();
    let other_secret = uuid::Uuid::new_v4().to_string();
    let secret_a = derive_child_execution_secret(&caller_secret, "job-1");
    let secret_b = derive_child_execution_secret(&caller_secret, "job-1");
    let secret_c = derive_child_execution_secret(&caller_secret, "job-2");
    assert_eq!(secret_a, secret_b);
    assert_ne!(secret_a, secret_c);
    assert_ne!(secret_a, caller_secret);
    assert_eq!(secret_a.len(), 64);
    assert_ne!(
        secret_a,
        derive_child_execution_secret(&other_secret, "job-1")
    );
}

#[test]
fn control_accepts_an_option_with_annotation_and_a_free_text_answer() {
    for answer in [
        json!({"optionId": "a", "text": "with this detail"}),
        json!({"text": "my answer"}),
    ] {
        let mut payload = serde_json::json!({
            "threadId": "jd7child",
            "action": "answer_question",
            "questionId": "jd7q"
        });
        payload
            .as_object_mut()
            .unwrap()
            .extend(answer.as_object().unwrap().clone());
        let control: ControlSubagentArgs = serde_json::from_value(payload).expect("control args");
        validate_control(&control).unwrap();
        assert!(matches!(
            control.action,
            SubagentControlAction::AnswerQuestion
        ));
        assert_eq!(control.question_id.as_deref(), Some("jd7q"));
    }
}

#[tokio::test(start_paused = true)]
async fn control_retries_a_lost_response_and_returns_the_committed_answer() {
    let mut attempts = 0;
    let response = control_mutation_with_retry("child", &WorkspaceCancellation::new(), || {
        attempts += 1;
        let attempt = attempts;
        async move {
            if attempt == 1 {
                Err(MutationFailure::Transport(anyhow::anyhow!("response lost")))
            } else {
                Ok(SubagentControlResponse {
                    stopped_run_id: None,
                    answer: Some(crate::subagents::SubagentCommittedAnswer {
                        option_id: Some("east".to_string()),
                        option_label: Some("East".to_string()),
                        text: None,
                    }),
                    already_answered: true,
                    continuation: None,
                })
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(attempts, 2);
    assert_eq!(response.answer.unwrap().option_id.as_deref(), Some("east"));
}

#[tokio::test(start_paused = true)]
async fn control_returns_function_errors_without_retrying() {
    let mut attempts = 0;
    let error = control_mutation_with_retry("child", &WorkspaceCancellation::new(), || {
        attempts += 1;
        async {
            Err(MutationFailure::Functional(anyhow::anyhow!(
                "question unavailable"
            )))
        }
    })
    .await
    .unwrap_err();
    assert_eq!(attempts, 1);
    assert!(error.to_string().contains("question unavailable"));
}

#[tokio::test(start_paused = true)]
async fn control_stalled_calls_finish_after_bounded_retries() {
    let mut attempts = 0;
    let error = control_mutation_with_retry("child", &WorkspaceCancellation::new(), || {
        attempts += 1;
        std::future::pending::<Result<SubagentControlResponse, MutationFailure>>()
    })
    .await
    .unwrap_err();
    assert_eq!(attempts, 3);
    assert!(error.to_string().contains("timed out calling"));
}

#[tokio::test]
async fn control_cancellation_drops_a_pending_call() {
    let cancellation = WorkspaceCancellation::new();
    let pending_cancellation = cancellation.clone();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let mut started_tx = Some(started_tx);
    let task = tokio::spawn(async move {
        control_mutation_with_retry("child", &pending_cancellation, || {
            if let Some(tx) = started_tx.take() {
                let _ = tx.send(());
            }
            std::future::pending::<Result<SubagentControlResponse, MutationFailure>>()
        })
        .await
    });
    started_rx.await.unwrap();
    cancellation.cancel();
    assert!(
        task.await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("cancelled")
    );
}
