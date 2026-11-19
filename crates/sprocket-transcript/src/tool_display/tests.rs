use serde_json::json;

use super::*;

fn display(name: &str, input: Value, output: Option<Value>) -> ToolDisplay {
    ToolDisplayInput::new(name, &input, output.as_ref(), ToolStatus::Completed).display(None)
}

fn shortened(mut display: ToolDisplay) -> (ToolDisplay, bool) {
    let has_more = display.shorten();
    (display, has_more)
}

#[test]
fn multi_target_polls_keep_labels_commands_and_errors() {
    for (name, input, output, summaries) in [
        (
            "poll_cmd",
            json!({"sessionIds": ["7", "missing"]}),
            Some(json!([
                {"sessionId":"7", "command":"bun run build", "workdir":"/repo"},
                {"sessionId":"missing", "error":"Unknown session."}
            ])),
            vec!["bun run build", "Session missing"],
        ),
        (
            "poll_subagent",
            json!({"threads":[{"threadId":"a"},{"threadId":"b","cursor":"3"}]}),
            None,
            vec!["a", "b"],
        ),
        (
            "poll_pr",
            json!({"pullRequests":[{"repository":"github.com/acme/repo","number":7}]}),
            None,
            vec!["github.com/acme/repo#7"],
        ),
    ] {
        let targets = polled_targets(name, &input, output.as_ref(), ToolStatus::Completed).unwrap();
        let displays: Vec<_> = targets.iter().map(|input| input.display(None)).collect();
        assert_eq!(
            displays
                .iter()
                .map(|display| display.summary.as_str())
                .collect::<Vec<_>>(),
            summaries
        );
        if name == "poll_cmd" {
            assert_eq!(displays[0].command.as_deref(), Some("bun run build"));
            assert_eq!(displays[1].status, ToolStatus::Failed);
            assert_eq!(displays[1].error.as_deref(), Some("Unknown session."));
        }
    }
    assert!(
        polled_targets(
            "poll_cmd",
            &json!({"sessionId":"7"}),
            None,
            ToolStatus::Completed
        )
        .is_none()
    );
}

#[test]
fn tool_labels_and_summaries() {
    for (name, input, expected_label, expected_summary) in [
        (
            "ask_question",
            json!({"question": "Which layout?"}),
            None,
            "Which layout?",
        ),
        ("await_question", json!({}), None, "Waiting for answer"),
        ("poll_question", json!({}), None, "Waiting for answer"),
        (
            "spawn_subagent",
            json!({"prompt": "Implement the design"}),
            Some("Delegated Tasks"),
            "Implement the design",
        ),
        (
            "control_subagent",
            json!({"action": "send", "prompt": "Refine it"}),
            Some("Controlled Subagents"),
            "Refine it",
        ),
        (
            "control_subagent",
            json!({"action": "send"}),
            Some("Controlled Subagents"),
            "Message child agent",
        ),
        (
            "control_subagent",
            json!({"action": "stop"}),
            Some("Controlled Subagents"),
            "Stop child agent",
        ),
        (
            "control_subagent",
            json!({"action": "answer_question"}),
            Some("Controlled Subagents"),
            "Answered question",
        ),
        (
            "control_subagent",
            json!({"threadId": "child"}),
            Some("Controlled Subagents"),
            "child",
        ),
        (
            "poll_subagent",
            json!({"threadId": "child"}),
            Some("Polled Subagents"),
            "child",
        ),
        ("list_subagents", json!({}), Some("Listed Subagents"), ""),
        (
            "list_subagent_models",
            json!({}),
            Some("Listed Subagent Models"),
            "",
        ),
        (
            "list_threads",
            json!({"query": "motor"}),
            Some("Listed Threads"),
            "motor",
        ),
        (
            "download_thread_transcripts",
            json!({"threadId": "child"}),
            Some("Downloaded Transcripts"),
            "child",
        ),
        (
            "check_docs",
            json!({"path": "docs/api"}),
            Some("Checked Docs"),
            "docs/api",
        ),
        (
            "bind_artifact",
            json!({"path": "notes.md"}),
            Some("Bound Artifact"),
            "notes.md",
        ),
        (
            "add_artifact",
            json!({"path": "notes.md"}),
            Some("Bound Artifact"),
            "notes.md",
        ),
        (
            "create_artifact",
            json!({"path": "notes.md"}),
            Some("Created Artifact"),
            "notes.md",
        ),
        (
            "edit_artifact",
            json!({"path": "notes.md"}),
            Some("Updated Artifact"),
            "notes.md",
        ),
        (
            "update_artifact",
            json!({"title": "Notes"}),
            Some("Updated Artifact"),
            "Notes",
        ),
        (
            "save_artifact",
            json!({"path": "notes.md"}),
            Some("Saved Artifact"),
            "notes.md",
        ),
        (
            "delete_artifact",
            json!({"artifactId": "artifact"}),
            Some("Deleted Artifact"),
            "artifact",
        ),
        (
            "get_workspace_instructions",
            json!({}),
            Some("Read Instructions"),
            "Workspace instructions",
        ),
        (
            "card_checkout",
            json!({"amount": "23.06", "currency": "usd"}),
            Some("Card Checkout"),
            "Paying 23.06 USD",
        ),
        (
            "poll_checkout",
            json!({}),
            Some("Checkout Approval"),
            "Waiting for approval",
        ),
        (
            "report_order",
            json!({"outcome": "failed"}),
            Some("Recorded Order"),
            "Recorded failed payment",
        ),
        (
            "report_order",
            json!({"orderNumber": "42"}),
            Some("Recorded Order"),
            "Recorded order 42",
        ),
        (
            "read_skill",
            json!({"name": "agent-browser"}),
            None,
            "$agent-browser",
        ),
        (
            "scrape_url",
            json!({"url": "https://react.dev"}),
            None,
            "https://react.dev",
        ),
        (
            "screenshot_url",
            json!({"url": "https://react.dev"}),
            Some("Captured Screenshot"),
            "https://react.dev",
        ),
        (
            "parse_file",
            json!({"path": "design.pdf"}),
            Some("Parsed File"),
            "design.pdf",
        ),
        (
            "set_cwd",
            json!({"path": "/repo"}),
            Some("Changed Directory"),
            "/repo",
        ),
        (
            "link_prs",
            json!({"pullRequests": [
                {"repository": "github.com/acme/widgets", "number": 7},
                {"repository": "github.com/acme/gadgets", "number": 12}
            ]}),
            Some("Linked PRs"),
            "github.com/acme/widgets#7, github.com/acme/gadgets#12",
        ),
        (
            "poll_pr",
            json!({"repository": "github.com/acme/widgets", "number": 7}),
            Some("Polled PRs"),
            "github.com/acme/widgets#7",
        ),
        (
            "web_search",
            json!({"query": "React reference"}),
            None,
            "React reference",
        ),
        (
            "lookup_parts",
            json!({"parts": [{"part": "C123"}, {"part": "C456"}]}),
            Some("Checked Parts"),
            "C123, C456",
        ),
        (
            "future_tool",
            json!({"private": "input"}),
            Some("Future Tool"),
            "Future Tool",
        ),
    ] {
        let actual = display(name, input, None);
        assert_eq!(actual.label.as_deref(), expected_label, "{name}");
        assert_eq!(actual.summary, expected_summary, "{name}");
    }
}

#[test]
fn results_supply_display_details() {
    for (name, input, output, expected) in [
        ("list_artifacts", json!({}), json!([{}]), "1 artifact"),
        (
            "list_artifacts",
            json!({}),
            json!({"artifacts": [{}, {}]}),
            "2 artifacts",
        ),
        (
            "list_artifacts",
            json!({}),
            json!({"artifacts": []}),
            "0 artifacts",
        ),
        (
            "bind_artifact",
            json!({"artifactId": "id"}),
            json!({"localPath": "/repo/notes.md", "title": "Notes"}),
            "/repo/notes.md",
        ),
        (
            "save_artifact",
            json!({"path": "chosen.md"}),
            json!({"path": "other.md"}),
            "chosen.md",
        ),
        (
            "web_search",
            json!({"query": "React"}),
            json!({"results": [{}]}),
            "React (1 result)",
        ),
        (
            "web_search",
            json!({"query": "React"}),
            json!({"results": [{}, {}]}),
            "React (2 results)",
        ),
    ] {
        assert_eq!(
            display(name, input, Some(output)).summary,
            expected,
            "{name}"
        );
    }
}

#[test]
fn patches_preserve_destination_paths_and_order() {
    let patch = "*** Begin Patch\n*** Update File: a.ts\n*** Move to: renamed.ts\n*** Copy File: b.ts\n*** Copy to: copied.ts\n*** Delete File: old.ts\n*** Add File: copied.ts\n*** End Patch";
    let actual = display("apply_patch", json!({"patch": patch}), None);
    assert_eq!(actual.label, None);
    assert_eq!(actual.summary, "renamed.ts\ncopied.ts\nold.ts");
    let (preview, has_more) = shortened(actual);
    assert_eq!(preview.summary, "renamed.ts");
    assert!(has_more);

    let diff = "diff --git a/a.ts b/a.ts\ndiff --git \"a/my file.ts\" \"b/my file.ts\"";
    assert_eq!(
        display("apply_patch", json!({"patch": diff}), None).summary,
        "a.ts\nmy file.ts"
    );
    assert_eq!(
        display(
            "apply_patch",
            json!({"patch": patch}),
            Some(json!({"changes": [{"path": "actual.ts"}, {"path": "actual.ts"}]}))
        )
        .summary,
        "actual.ts"
    );
}

#[test]
fn command_aliases_and_fallbacks() {
    for name in ["exec_cmd", "exec_command"] {
        for (workdir, expected) in [
            (".", "bun run build"),
            (" \t ", "bun run build"),
            ("/repo", "bun run build (cwd /repo)"),
        ] {
            let actual = display(
                name,
                json!({"cmd": "bun run build", "workdir": workdir}),
                None,
            );
            assert_eq!(actual.label, None);
            assert_eq!(actual.summary, expected);
            assert_eq!(actual.command.as_deref(), Some("bun run build"));
        }
    }
    for name in [
        "poll_cmd",
        "poll_command",
        "write_stdin",
        "control_cmd",
        "control_command",
    ] {
        let input = json!({"sessionId": "7", "action": "terminate"});
        let tool = ToolDisplayInput::new(name, &input, None, ToolStatus::Completed);
        let known = tool.display(Some("bun run build"));
        assert_eq!(known.summary, "bun run build");
        assert_eq!(known.command.as_deref(), Some("bun run build"));
        assert_eq!(
            tool.display(None).summary,
            if name.starts_with("control") {
                "Terminate Session 7"
            } else {
                "Session 7"
            }
        );
        assert_eq!(tool.display(None).label, None);
    }
    assert_eq!(
        display(
            "control_cmd",
            json!({"sessionId": "7", "action": "write"}),
            None
        )
        .summary,
        "Write to Session 7"
    );
    assert_eq!(
        display("poll_cmd", json!({}), None).summary,
        "Command session"
    );
}

#[test]
fn session_command_comes_from_local_history() {
    let directory = tempfile::tempdir().unwrap();
    let sessions = directory.path().join("command-logs/sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let id = uuid::Uuid::new_v4();
    std::fs::write(
        sessions.join(format!("{id}.json")),
        br#"{"command":"bun run build","result":{"output":"private"}}"#,
    )
    .unwrap();
    let input = json!({"sessionId": id});
    let output = json!({"command": "older output command"});
    let mut commands = SessionCommands::new(directory.path().to_owned());
    for name in [
        "poll_cmd",
        "control_cmd",
        "poll_command",
        "control_command",
        "write_stdin",
    ] {
        let tool = ToolDisplayInput::new(name, &input, Some(&output), ToolStatus::Completed);
        let command = commands.get(tool.session_id().unwrap());
        assert_eq!(tool.display(command).summary, "bun run build");
    }
    let missing = json!({"sessionId": uuid::Uuid::new_v4()});
    let tool = ToolDisplayInput::new("poll_cmd", &missing, Some(&output), ToolStatus::Completed);
    assert_eq!(commands.get(tool.session_id().unwrap()), None);
    assert_eq!(commands.get("not-a-uuid"), None);
    assert_eq!(tool.display(None).summary, "older output command");
}

#[test]
fn errors_preserve_failure_kind_and_text() {
    let input = json!({"path": "file"});
    for (status, output, expected_status, expected_error) in [
        (ToolStatus::Running, None, ToolStatus::Running, None),
        (ToolStatus::Completed, None, ToolStatus::Completed, None),
        (
            ToolStatus::Completed,
            Some(json!({"status": "failed", "error": "Tool failed"})),
            ToolStatus::Failed,
            Some("Tool failed"),
        ),
        (
            ToolStatus::Completed,
            Some(json!({"status": "cancelled", "error": "Cancelled by user"})),
            ToolStatus::Cancelled,
            Some("Cancelled by user"),
        ),
        (
            ToolStatus::Failed,
            Some(json!({"error": "Output error"})),
            ToolStatus::Failed,
            Some("Output error"),
        ),
        (
            ToolStatus::Failed,
            None,
            ToolStatus::Failed,
            Some("Executor job failed."),
        ),
        (
            ToolStatus::Cancelled,
            None,
            ToolStatus::Cancelled,
            Some("Tool stopped before completion."),
        ),
    ] {
        let actual =
            ToolDisplayInput::new("parse_file", &input, output.as_ref(), status).display(None);
        assert_eq!(actual.status, expected_status);
        assert_eq!(actual.error.as_deref(), expected_error);
    }
}

#[test]
fn saved_tool_actions_are_display_only() {
    let actual = display(
        "parse_file",
        json!({"path": "design.pdf"}),
        Some(json!({"source": {"path": "/repo/docs/design.pdf"}, "text": "private file contents"})),
    );
    assert_eq!(
        actual.action,
        Some(ToolDisplayAction::OpenFile {
            path: "/repo/docs/design.pdf".into()
        })
    );
    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        json!({"label": "Parsed File", "summary": "design.pdf", "status": "completed", "action": {"kind": "openFile", "path": "/repo/docs/design.pdf"}})
    );

    let checkout = display(
        "card_checkout",
        json!({"amount": "23.06", "currency": "USD", "payButton": "private"}),
        Some(json!({"status": "card_required"})),
    );
    assert_eq!(
        serde_json::to_value(checkout).unwrap(),
        json!({"label": "Card Checkout", "summary": "Paying 23.06 USD", "status": "completed", "action": {"kind": "saveCard"}})
    );
}

#[test]
fn row_summary_is_one_line_and_unicode_safe() {
    for (question, preview, has_more) in [
        ("a".repeat(300), "a".repeat(300), false),
        ("🦀".repeat(301), "🦀".repeat(300), true),
        ("First\nSecond".into(), "First".into(), true),
        ("First\r\nSecond".into(), "First".into(), true),
        ("First\n".into(), "First".into(), true),
        (String::new(), String::new(), false),
    ] {
        let (row, actual_has_more) =
            shortened(display("ask_question", json!({"question": question}), None));
        assert_eq!(row.summary, preview);
        assert_eq!(actual_has_more, has_more);
    }
}
