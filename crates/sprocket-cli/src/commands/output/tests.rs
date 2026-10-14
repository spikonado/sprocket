use super::*;
use sprocket_server::cli_protocol::CliRunSettings;

fn snapshot(parts: serde_json::Value) -> CliRunSnapshot {
    serde_json::from_value(serde_json::json!({
        "runId": "run", "threadId": "thread", "status": "running",
        "error": null, "parts": parts, "hasMore": false, "executionFinished": false, "live": null,
        "revision": 1, "answer": "",
    }))
    .unwrap()
}

#[test]
fn start_keeps_the_resolved_settings_for_the_run_header() {
    let mut output = Output::new();
    output
        .start(RunStarted {
            run_id: "run".into(),
            thread_id: "thread".into(),
            settings: CliRunSettings {
                model: "model".into(),
                reasoning: "high".into(),
                fast: true,
            },
        })
        .unwrap();
    assert_eq!(
        run_header(output.started().unwrap()),
        "Thread thread | Run run\nModel model | Reasoning high | Fast on"
    );
}

#[test]
fn final_answer_comes_from_the_confirmed_result_not_transcript_commentary() {
    let mut output = Output::new();
    output.started = Some(RunStarted {
        run_id: "run".into(),
        thread_id: "thread".into(),
        settings: CliRunSettings {
            model: "model".into(),
            reasoning: "high".into(),
            fast: false,
        },
    });
    let commentary = snapshot(serde_json::json!([{
        "number": 1, "sourceKey": "one", "kind": "completion", "runId": "run",
        "completion": {"items": [{"type": "text", "text": "I'll inspect the files."}, {"type": "tool-call"}]}
    }]));
    output.update(&commentary).unwrap();
    assert!(output.answer.is_empty());
    output.update(&snapshot(serde_json::json!([{
        "number": 3, "sourceKey": "three", "kind": "completion", "runId": "run",
        "completion": {"items": [{"type": "reasoning", "text": "private"}, {"type": "text", "text": "Done."}]}
    }]))).unwrap();
    assert!(output.answer.is_empty());
    assert_eq!(output.after_part(), 3);
    let mut result = snapshot(serde_json::json!([]));
    result.answer = "Confirmed answer.".into();
    result.execution_finished = true;
    output.update(&result).unwrap();
    assert_eq!(output.answer, "Confirmed answer.");
    assert_eq!(output.after_revision(), Some(result.revision));
    result.has_more = true;
    output.update(&result).unwrap();
    assert_eq!(output.after_revision(), None);
}

#[test]
fn rejects_another_runs_transcript_without_advancing_cursor() {
    let mut output = Output::new();
    output.started = Some(RunStarted {
        run_id: "run".into(),
        thread_id: "thread".into(),
        settings: CliRunSettings {
            model: "model".into(),
            reasoning: "high".into(),
            fast: false,
        },
    });
    let page = snapshot(serde_json::json!([{
        "number": 1, "sourceKey": "one", "kind": "completion", "runId": "other",
        "completion": {"items": [{"type": "text", "text": "wrong answer"}]}
    }]));
    assert!(output.update(&page).is_err());
    assert_eq!(output.after_part(), -1);
}
