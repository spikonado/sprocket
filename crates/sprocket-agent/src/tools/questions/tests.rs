use super::*;

fn snapshot(question_id: &str, status: &str) -> QuestionSnapshot {
    QuestionSnapshot {
        question_id: question_id.to_string(),
        status: status.to_string(),
        answer: (status == "answered").then(|| QuestionAnswer {
            option_id: Some("safe".to_string()),
            option_label: Some("Use the safe default".to_string()),
            text: None,
        }),
    }
}

#[test]
fn question_parameters_expose_optional_expiry_and_bounded_waits() {
    let ask = ask_question_parameters(270_000);
    assert_eq!(ask["required"], json!(["question", "options"]));
    assert_eq!(ask["additionalProperties"], false);
    assert!(ask["properties"]["question"].get("description").is_none());
    assert_eq!(ask["properties"]["options"]["minItems"], 1);
    assert_eq!(ask["properties"]["options"]["maxItems"], 4);
    assert_eq!(
        ask["properties"]["options"]["description"],
        "Answer options. A \"Let me (the agent) decide\" option is added automatically."
    );
    let option = &ask["$defs"]["AskQuestionOption"];
    assert_eq!(option["additionalProperties"], false);
    assert!(option["properties"]["label"].get("description").is_none());
    assert_eq!(option["properties"]["id"]["maxLength"], 20);
    let yield_ms = &ask["properties"]["yieldTimeMs"];
    assert_eq!(yield_ms["default"], 10_000);
    assert_eq!(yield_ms["minimum"], 0);
    assert_eq!(yield_ms["maximum"], 270_000);
    let timeout = &ask["properties"]["timeoutMs"];
    assert_eq!(timeout["type"], json!(["integer", "null"]));
    assert_eq!(timeout["minimum"], 0);
    assert!(timeout.get("default").is_none());
    assert!(timeout.get("maximum").is_none());
    let poll_schema = poll_question_parameters(270_000);
    assert_eq!(poll_schema["required"], json!(["questionId"]));
    assert_eq!(poll_schema["properties"]["yieldTimeMs"]["default"], 10_000);
    assert_eq!(
        poll_schema["properties"]["yieldTimeMs"]["anyOf"],
        json!([
            { "type": "integer", "enum": [0] },
            { "type": "integer", "minimum": 10_000, "maximum": 270_000 }
        ])
    );
}

#[test]
fn commands_and_questions_advertise_the_same_wait_policy() {
    use super::super::commands::{
        control_command_parameters, exec_command_parameters, poll_command_parameters,
    };

    let ask_wait = ask_question_parameters(270_000)["properties"]["yieldTimeMs"].clone();
    for schema in [
        exec_command_parameters(270_000),
        control_command_parameters(270_000),
    ] {
        assert_eq!(schema["properties"]["yieldTimeMs"], ask_wait);
    }

    let mut command_wait = poll_command_parameters(270_000)["properties"]["yieldTimeMs"].clone();
    let mut question_wait = poll_question_parameters(270_000)["properties"]["yieldTimeMs"].clone();
    command_wait.as_object_mut().unwrap().remove("description");
    question_wait.as_object_mut().unwrap().remove("description");
    assert_eq!(command_wait, question_wait);
}

#[test]
fn ask_args_accept_absent_null_and_historical_numeric_timeouts() {
    for timeout in [
        None,
        Some(json!(null)),
        Some(json!(0)),
        Some(json!(1_800_000)),
    ] {
        let mut payload = json!({
            "question": "Which configuration?",
            "options": [{ "id": "safe", "label": "Use the safe default" }],
        });
        if let Some(timeout) = timeout {
            payload["timeoutMs"] = timeout;
        }
        let args: AskQuestionArgs = serde_json::from_value(payload.clone()).unwrap();
        assert_eq!(args.yield_time_ms, 10_000);
        assert_eq!(args.timeout_ms, payload["timeoutMs"].as_u64());
    }
}

#[test]
fn question_results_return_status_and_answer_with_ids_only_on_creation() {
    for status in ["pending", "answered", "timedOut"] {
        let observed = snapshot("q1", status);
        let result = question_result_from_snapshot(&observed).unwrap();
        let mut expected =
            json!({"pending": status == "pending", "timedOut": status == "timedOut"});
        if status == "answered" {
            expected["answer"] = json!({"optionId": "safe", "optionLabel": "Use the safe default"});
        }
        assert_eq!(result, expected);
        let creation = question_creation_result(result.clone(), "q1", 10_000);
        expected["questionId"] = json!("q1");
        assert_eq!(creation, expected);
        expected.as_object_mut().unwrap().remove("answer");
        assert_eq!(question_creation_result(result, "q1", 0), expected);
    }
}

#[test]
fn cancelled_questions_fail_the_poll_as_an_ordinary_tool_error() {
    let error = question_result_from_snapshot(&snapshot("q1", "cancelled")).unwrap_err();
    assert_eq!(error.kind(), rig::tool::ToolErrorKind::Other);
}

#[tokio::test(start_paused = true)]
async fn pending_zero_polls_are_atomic_per_question_and_rejections_do_not_reset_them() {
    let polls = QuestionPolls::default();
    let concurrent_polls = polls.clone();
    let fetch = || async { Ok(snapshot("q1", "pending")) };
    let (first, second) = tokio::join!(
        polls.observe_pending("q1", fetch),
        concurrent_polls.observe_pending("q1", fetch),
    );
    assert!(first.is_ok());
    assert_eq!(
        second.unwrap_err().to_string(),
        "Question is still awaiting an answer. Check again after 10s or use a higher `yieldTimeMs`."
    );
    assert!(
        polls
            .observe_pending("q2", || async { Ok(snapshot("q2", "pending")) })
            .await
            .is_ok()
    );
    tokio::time::advance(Duration::from_millis(9_001)).await;
    assert_eq!(
        polls
            .observe_pending("q1", fetch)
            .await
            .unwrap_err()
            .to_string(),
        "Question is still awaiting an answer. Check again after 1s or use a higher `yieldTimeMs`."
    );
    tokio::time::advance(Duration::from_millis(999)).await;
    assert!(polls.observe_pending("q1", fetch).await.is_ok());
}

#[tokio::test(start_paused = true)]
async fn terminal_and_failed_reads_do_not_change_pending_poll_timestamp() {
    let polls = QuestionPolls::default();
    polls
        .observe_pending("q1", || async { Ok(snapshot("q1", "pending")) })
        .await
        .unwrap();
    tokio::time::advance(Duration::from_secs(9)).await;
    for status in ["answered", "timedOut"] {
        for _ in 0..2 {
            let result = polls
                .observe_pending("q1", || async { Ok(snapshot("q1", status)) })
                .await
                .unwrap();
            assert_eq!(result["pending"], false);
        }
    }
    assert!(
        polls
            .observe_pending("q1", || async { Err(tool_failure("query failed")) })
            .await
            .is_err()
    );
    tokio::time::advance(Duration::from_secs(1)).await;
    assert!(
        polls
            .observe_pending("q1", || async { Ok(snapshot("q1", "pending")) })
            .await
            .is_ok()
    );
}

#[tokio::test(start_paused = true)]
async fn contending_zero_poll_rechecks_terminal_state() {
    let polls = QuestionPolls::default();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let first_polls = polls.clone();
    let first = tokio::spawn(async move {
        first_polls
            .observe_pending("q1", || async {
                started_tx.send(()).unwrap();
                release_rx.await.unwrap();
                Ok(snapshot("q1", "pending"))
            })
            .await
    });
    started_rx.await.unwrap();
    let second = tokio::spawn(async move {
        polls
            .observe_pending("q1", || async { Ok(snapshot("q1", "answered")) })
            .await
    });
    tokio::task::yield_now().await;
    release_tx.send(()).unwrap();
    first.await.unwrap().unwrap();
    let result = second.await.unwrap().unwrap();
    assert_eq!(result["answer"]["optionId"], "safe");
}

#[tokio::test(start_paused = true)]
async fn pending_updates_keep_waiting_until_answer() {
    let initial = snapshot("q1", "pending");
    let (tx, mut rx) = futures::channel::mpsc::unbounded();
    let wait = wait_for_question_updates(
        &mut rx,
        &initial,
        Instant::now() + Duration::from_secs(10),
        || async {
            panic!("answer should end wait before deadline");
        },
    );
    tokio::pin!(wait);
    tx.unbounded_send(Ok(Some(initial.clone()))).unwrap();
    tokio::select! {
        result = &mut wait => panic!("pending update ended wait: {result:?}"),
        _ = tokio::task::yield_now() => {}
    }
    tokio::time::advance(Duration::from_secs(2)).await;
    tx.unbounded_send(Ok(Some(snapshot("q1", "answered"))))
        .unwrap();
    assert_eq!(wait.await.unwrap()["answer"]["optionId"], "safe");
}

#[tokio::test(start_paused = true)]
async fn wait_deadline_performs_an_authoritative_read() {
    let initial = snapshot("q1", "pending");
    for status in ["pending", "answered", "timedOut"] {
        let mut updates = futures::stream::pending();
        let result = wait_for_question_updates(
            &mut updates,
            &initial,
            Instant::now() + Duration::from_millis(5),
            || async { Ok(snapshot("q1", status)) },
        )
        .await
        .unwrap();
        assert_eq!(result["pending"], status == "pending");
        assert_eq!(result["timedOut"], status == "timedOut");
    }
}
