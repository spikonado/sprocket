use super::*;
use sprocket_transcript::{TranscriptCompletionBody, TranscriptPartKind};

fn completion(number: u32, text: &str) -> TranscriptPart {
    TranscriptPart {
        number,
        source_key: format!("completion:run:{number}"),
        kind: TranscriptPartKind::Completion,
        run_id: "run".into(),
        created_at: None,
        prompt: None,
        tool: None,
        completion: Some(TranscriptCompletionBody {
            stream_id: None,
            items: vec![serde_json::json!({"type": "text", "text": text})],
        }),
        work: Default::default(),
    }
}

fn output(directory: &std::path::Path) -> RunOutput {
    let output = RunOutput::default();
    output.initialize(
        TranscriptStore::new(directory.to_owned()),
        "user".into(),
        "thread".into(),
        "run".into(),
    );
    output
}

#[tokio::test]
async fn caches_committed_parts_and_replays_bounded_pages_without_network_reads() {
    let directory = tempfile::tempdir().unwrap();
    let output = output(directory.path());
    for number in 0..18 {
        output
            .record_part(completion(number * 2, &format!("answer {number}")))
            .await;
    }
    output
        .record_part(completion(0, "duplicate must not replace answer"))
        .await;
    let first = output.page(-1).await.unwrap();
    assert_eq!(first.parts.len(), 16);
    assert!(first.has_more);
    assert_eq!(first.parts[0].number, 0);
    assert_eq!(first.parts[15].number, 30);
    assert!(first.answer.is_empty());
    let replay = output.page(-1).await.unwrap();
    assert_eq!(first.parts, replay.parts);
    output.finalized(
        RunOutcome {
            status: "completed".into(),
            error: None,
        },
        true,
    );
    assert!(!output.page(30).await.unwrap().finished);
    output.finish(None);
    let last = output.page(30).await.unwrap();
    assert_eq!(last.parts.len(), 2);
    assert!(!last.has_more);
    assert!(last.finished);
    assert_eq!(last.answer, "answer 17");
    assert!(output.page(-2).await.is_err());
}

#[tokio::test]
async fn clearing_live_output_does_not_complete_a_run_and_unconfirmed_exit_is_unknown() {
    let directory = tempfile::tempdir().unwrap();
    let output = output(directory.path());
    let mut changed = output.subscribe();
    output.notify_live_update();
    changed.changed().await.unwrap();
    assert!(!output.page(-1).await.unwrap().finished);
    output
        .record_part(completion(1, "unconfirmed answer"))
        .await;
    output.finish(Some("finalization timed out".into()));
    let page = output.page(-1).await.unwrap();
    assert!(page.finished);
    assert_eq!(page.outcome.unwrap().status, "unknown");
    assert!(page.answer.is_empty());
}

#[tokio::test]
async fn cancelled_and_empty_completions_do_not_return_earlier_commentary() {
    let directory = tempfile::tempdir().unwrap();
    let output = output(directory.path());
    output.record_part(completion(1, "earlier answer")).await;
    output.empty_completion();
    output.finalized(
        RunOutcome {
            status: "completed".into(),
            error: None,
        },
        true,
    );
    output.finish(None);
    assert!(output.page(-1).await.unwrap().answer.is_empty());

    let directory = tempfile::tempdir().unwrap();
    let cancelled = self::output(directory.path());
    cancelled
        .record_part(completion(1, "answer before cancellation race"))
        .await;
    cancelled.finalized(
        RunOutcome {
            status: "cancelled".into(),
            error: None,
        },
        false,
    );
    cancelled.finish(None);
    let page = cancelled.page(-1).await.unwrap();
    assert!(page.answer.is_empty());
    assert_eq!(page.outcome.unwrap().status, "cancelled");
}

#[tokio::test]
async fn tool_commentary_and_other_runs_cannot_become_the_final_answer() {
    let directory = tempfile::tempdir().unwrap();
    let output = output(directory.path());
    let mut part = completion(2, "I'll run the tests.");
    part.completion.as_mut().unwrap().items.push(serde_json::json!({"type": "tool-call", "callId": "call", "name": "exec_command", "input": {}}));
    output.record_part(part).await;
    let mut other = completion(3, "another run's answer");
    other.run_id = "other".into();
    output.record_part(other).await;
    output.finalized(
        RunOutcome {
            status: "completed".into(),
            error: None,
        },
        true,
    );
    output.finish(None);
    let page = output.page(-1).await.unwrap();
    assert_eq!(page.parts.len(), 1);
    assert!(page.answer.is_empty());
}

#[tokio::test]
async fn another_executors_completion_cannot_confirm_the_local_answer() {
    let directory = tempfile::tempdir().unwrap();
    let output = output(directory.path());
    output
        .record_part(completion(1, "stale local answer"))
        .await;
    output.finalized(
        RunOutcome {
            status: "completed".into(),
            error: None,
        },
        false,
    );
    output.finish(Some("claim ownership was lost".into()));
    let page = output.page(-1).await.unwrap();
    assert_eq!(page.outcome.unwrap().status, "completed");
    assert!(
        page.output_error
            .unwrap()
            .contains("final answer could not be confirmed")
    );
    assert!(page.answer.is_empty());
}

#[tokio::test]
async fn failed_cache_writes_preserve_the_acknowledged_answer_and_terminal_status() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let output = output(file.path());
    output.record_part(completion(1, "Confirmed answer.")).await;
    output.finalized(
        RunOutcome {
            status: "completed".into(),
            error: None,
        },
        true,
    );
    output.finish(None);
    let page = output.page(-1).await.unwrap();
    assert_eq!(page.outcome.unwrap().status, "completed");
    assert_eq!(page.answer, "Confirmed answer.");
    assert!(page.output_error.unwrap().contains("Could not cache"));
    assert!(page.parts.is_empty());
    assert!(!page.has_more);
}

#[tokio::test]
async fn lost_cache_files_do_not_erase_a_confirmed_result_or_restart_paging() {
    let directory = tempfile::tempdir().unwrap();
    let output = output(directory.path());
    output.record_part(completion(1, "Confirmed answer.")).await;
    output.finalized(
        RunOutcome {
            status: "completed".into(),
            error: None,
        },
        true,
    );
    output.finish(None);
    tokio::fs::remove_dir_all(directory.path()).await.unwrap();
    for _ in 0..2 {
        let page = output.page(-1).await.unwrap();
        assert_eq!(page.outcome.unwrap().status, "completed");
        assert_eq!(page.answer, "Confirmed answer.");
        assert!(page.output_error.unwrap().contains("Could not read"));
        assert!(page.parts.is_empty());
        assert!(!page.has_more);
    }
}
