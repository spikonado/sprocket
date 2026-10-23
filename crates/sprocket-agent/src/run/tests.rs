use super::{
    base_instructions, should_continue_without_prompt, submission_owned_by_another_executor,
};

const MODEL_LABEL: &str = "GPT-5.6 Sol";
const MODEL_ID: &str = "gpt-5.6-sol";

#[tokio::test]
async fn context_readiness_uses_captured_cutoff_and_cached_handoff_part() {
    use sprocket_transcript::{DownloadOrder, TranscriptPart, TranscriptState, TranscriptStore};
    use std::sync::Mutex;

    fn prompt(number: u32) -> TranscriptPart {
        serde_json::from_value(serde_json::json!({
            "number": number, "sourceKey": format!("prompt:{number}"),
            "runId": if number == 109 { "current-run" } else { "old-run" },
            "kind": "prompt", "prompt": {"text": format!("Part {number}"), "imageUploads": []}
        }))
        .unwrap()
    }

    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    store
        .append_parts("user", "thread", &[prompt(109)])
        .await
        .unwrap();
    let mut state = TranscriptState::new("user".into(), "thread".into());
    state.history_from_number = 110;
    state.remote_total_parts = 120;
    state.context_summary = Some("Captured summary".into());
    state.reasoning_stripped_through_part_number = Some(112);
    let requests = Mutex::new(Vec::new());
    let (parts, handoff) = super::load_context_parts(
        &store,
        "user",
        "thread",
        &state,
        "current-run",
        |start, end, order| {
            assert!(matches!(order, DownloadOrder::Desc));
            requests.lock().unwrap().push((start, end));
            let store = store.clone();
            async move {
                store.append_parts("user", "thread", &[prompt(120)]).await?;
                store
                    .update_state("user", "thread", |state| {
                        state.history_from_number = 120;
                        state.remote_total_parts = 121;
                        state.context_summary = Some("Newer summary".into());
                    })
                    .await?;
                Ok((start.max(end - 3)..end).rev().map(prompt).collect())
            }
        },
    )
    .await
    .unwrap();
    assert!(handoff);
    assert_eq!(parts, (110..120).map(prompt).collect::<Vec<_>>());
    assert!(
        requests
            .lock()
            .unwrap()
            .iter()
            .all(|&(start, end)| start >= 110 && end <= 120)
    );
    let (cached, handoff) = super::load_context_parts(
        &store,
        "user",
        "thread",
        &state,
        "current-run",
        |_, _, _| async {
            Err(anyhow::anyhow!(
                "cached context requested remote transcript parts"
            ))
        },
    )
    .await
    .unwrap();
    assert_eq!(cached, parts);
    assert!(handoff);
}

#[test]
fn prompted_continuations_use_their_user_prompt() {
    assert!(!should_continue_without_prompt(false, true, "Ship it"));
    assert!(should_continue_without_prompt(false, true, ""));
    assert!(should_continue_without_prompt(true, true, "Ship it"));
}

#[test]
fn submission_conflict_errors_match_the_convex_sentinel() {
    assert!(submission_owned_by_another_executor(
        "agentRuntime:createGatewayRun failed: Submission belongs to a different active executor."
    ));
    assert!(submission_owned_by_another_executor(
        "Submission belongs to a different or incomplete run."
    ));
    assert!(!submission_owned_by_another_executor(
        "timed out starting agent run"
    ));
    assert!(!submission_owned_by_another_executor(
        "Submission prompt does not match the existing run."
    ));
}

#[test]
fn base_instructions_include_the_selected_model_identity() {
    let instructions = base_instructions(MODEL_LABEL, MODEL_ID);

    assert!(
        instructions
            .lines()
            .any(|line| line == "- Your model is GPT-5.6 Sol (gpt-5.6-sol).")
    );
    assert!(!instructions.contains(super::MODEL_IDENTITY_PLACEHOLDER));
}

#[test]
fn restore_cwd_uses_the_saved_directory_while_it_exists() {
    let dir = tempfile::tempdir().unwrap();
    let root = sprocket_workspace::simplified_path(
        sprocket_workspace::resolve_directory(dir.path(), ".").unwrap(),
    );
    let nested = root.join("nested");
    std::fs::create_dir(&nested).unwrap();

    assert_eq!(super::restore_cwd(&root, None), root);
    assert_eq!(
        super::restore_cwd(&root, Some(&nested.to_string_lossy())),
        nested
    );
    std::fs::remove_dir(&nested).unwrap();
    assert_eq!(
        super::restore_cwd(&root, Some(&nested.to_string_lossy())),
        root
    );
}
