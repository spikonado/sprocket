use rig::completion::Message;
use rig::message::UserContent;
use sprocket_workspace::{
    SkillSource, WorkspaceInstruction, WorkspaceInstructionSource, WorkspaceSkill,
};

use super::{
    build_workspace_prompt_context, should_continue_without_prompt,
    submission_owned_by_another_executor,
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

fn initial_context_text(message: &Message) -> &str {
    match message {
        Message::User { content } => match content.first() {
            Some(UserContent::Text(text)) => &text.text,
            other => panic!("expected initial context text, got {other:?}"),
        },
        other => panic!("expected initial context user message, got {other:?}"),
    }
}

fn build_test_prompt_context(
    workspace_instructions: &[WorkspaceInstruction],
    skills: &[WorkspaceSkill],
) -> super::WorkspacePromptContext {
    build_workspace_prompt_context(
        "/tmp/project",
        workspace_instructions,
        skills,
        MODEL_LABEL,
        MODEL_ID,
        "thread-id",
        std::path::Path::new("/tmp/transcripts/user/thread-id"),
    )
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
    let prompt_context = build_test_prompt_context(&[], &[]);

    assert!(
        prompt_context
            .base_instructions
            .lines()
            .any(|line| line == "- Your model is GPT-5.6 Sol (gpt-5.6-sol).")
    );
    assert!(
        !prompt_context
            .base_instructions
            .contains(super::MODEL_IDENTITY_PLACEHOLDER)
    );
}

#[test]
fn thread_section_includes_the_thread_id_and_transcript_location() {
    for (data_dir, thread_id) in [
        ("/home/user/.sprocket", "first-thread-id"),
        ("/srv/custom sprocket data", "second-thread-id"),
    ] {
        let store = sprocket_transcript::TranscriptStore::new(
            std::path::Path::new(data_dir).join("transcripts"),
        );
        let transcript_dir = store.thread_dir("user-id", thread_id);
        let prompt_context = build_workspace_prompt_context(
            "/tmp/project",
            &[],
            &[],
            MODEL_LABEL,
            MODEL_ID,
            thread_id,
            &transcript_dir,
        );
        let thread_section = prompt_context
            .base_instructions
            .split_once("\n## This thread\n")
            .unwrap()
            .1;
        assert!(thread_section.contains(&format!(
            "- This conversation/thread's ID is {thread_id}. Thread transcripts and attachments are stored in `{}`.",
            transcript_dir.display()
        )));
        assert!(
            !prompt_context
                .base_instructions
                .contains(super::THREAD_ID_PLACEHOLDER)
        );
        assert!(
            !prompt_context
                .base_instructions
                .contains(super::TRANSCRIPT_DIR_PLACEHOLDER)
        );
        assert!(!thread_section.contains("~/.sprocket/"));
    }
}

#[test]
fn initial_context_renders_skills_block() {
    let skills = [WorkspaceSkill {
        name: "pdf-processing".to_string(),
        description: "Handle PDFs".to_string(),
        disable_model_invocation: false,
        source: SkillSource::BuiltIn {
            contents: "---\nname: pdf-processing\ndescription: Handle PDFs\n---\n",
        },
    }];
    let prompt_context = build_test_prompt_context(&[], &skills);
    let initial_context = initial_context_text(&prompt_context.initial_context);
    assert!(initial_context.starts_with("# Thread-Scoped Workspace Context\n"));
    assert!(initial_context.contains("## Available Skills"));
    assert!(initial_context.contains("<SKILLS>"));
    assert!(initial_context.contains("- name: pdf-processing"));
    assert!(initial_context.contains("description: Handle PDFs"));
    assert!(!initial_context.contains("No skills are installed."));
    assert!(!prompt_context.base_instructions.contains("pdf-processing"));
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

#[test]
fn initial_context_renders_empty_skills_line() {
    let prompt_context = build_test_prompt_context(&[], &[]);
    let initial_context = initial_context_text(&prompt_context.initial_context);
    assert!(initial_context.contains("## Available Skills"));
    assert!(initial_context.contains("No skills are installed."));
    assert!(!initial_context.contains("<SKILLS>"));
}

#[test]
fn initial_context_omits_disabled_skills() {
    let skills = [
        WorkspaceSkill {
            name: "deploy".to_string(),
            description: "Deploy production".to_string(),
            disable_model_invocation: true,
            source: SkillSource::BuiltIn { contents: "" },
        },
        WorkspaceSkill {
            name: "ordinary".to_string(),
            description: "Ordinary skill".to_string(),
            disable_model_invocation: false,
            source: SkillSource::BuiltIn { contents: "" },
        },
    ];
    let prompt_context = build_test_prompt_context(&[], &skills);
    let initial_context = initial_context_text(&prompt_context.initial_context);
    assert!(initial_context.contains("- name: ordinary"));
    assert!(!initial_context.contains("deploy"));
    assert!(!initial_context.contains("Deploy production"));

    let only_disabled = build_test_prompt_context(&[], &skills[..1]);
    let initial_context = initial_context_text(&only_disabled.initial_context);
    assert!(!initial_context.contains("deploy"));
    assert!(!initial_context.contains("<SKILLS>"));
}

#[test]
fn initial_context_collapses_multiline_skill_descriptions() {
    let skills = [WorkspaceSkill {
        name: "demo".to_string(),
        description: "Line one\nline two".to_string(),
        disable_model_invocation: false,
        source: SkillSource::BuiltIn {
            contents: "---\nname: demo\ndescription: Line one\n---\n",
        },
    }];
    let prompt_context = build_test_prompt_context(&[], &skills);
    let initial_context = initial_context_text(&prompt_context.initial_context);
    assert!(initial_context.contains("description: Line one line two"));
    assert!(!initial_context.contains("description: Line one\n"));
}

#[test]
fn initial_context_renders_user_instructions_before_workspace_instructions() {
    let user_instructions = "Use the user's preferred test runner.";
    let workspace_instructions = "Keep generated board files in hardware/output.";
    let instructions = [
        WorkspaceInstruction {
            path: "/home/user/.agents/AGENTS.md".to_string(),
            directory: "/home/user/.agents".to_string(),
            contents: user_instructions.to_string(),
            truncated: false,
            source: WorkspaceInstructionSource::User,
        },
        WorkspaceInstruction {
            path: "/tmp/project/AGENTS.md".to_string(),
            directory: "/tmp/project".to_string(),
            contents: workspace_instructions.to_string(),
            truncated: false,
            source: WorkspaceInstructionSource::Workspace,
        },
    ];

    let prompt_context = build_test_prompt_context(&instructions, &[]);
    let initial_context = initial_context_text(&prompt_context.initial_context);

    let user_heading = "### The user's AGENTS.md";
    let workspace_heading = "### AGENTS.md instructions for /tmp/project";
    let agents_heading = "## Preloaded AGENTS.md Instructions";
    assert!(initial_context.contains(agents_heading));
    assert!(initial_context.contains(user_heading));
    assert!(initial_context.contains(workspace_heading));
    assert!(initial_context.contains(user_instructions));
    assert!(initial_context.contains(workspace_instructions));
    assert!(
        initial_context
            .find(agents_heading)
            .expect("agents heading")
            < initial_context.find(user_heading).expect("user heading")
    );
    assert!(
        initial_context.find(user_heading).expect("user heading")
            < initial_context
                .find(workspace_heading)
                .expect("workspace heading")
    );
    assert!(!prompt_context.base_instructions.contains(user_instructions));
    assert!(
        !prompt_context
            .base_instructions
            .contains(workspace_instructions)
    );
}
