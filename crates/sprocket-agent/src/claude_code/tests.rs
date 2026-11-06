use super::*;

fn turn(messages: Value) -> Turn {
    let body = json!({
        "model": "claude-opus-5-5",
        "system": [{ "type": "text", "text": "Workspace notes", "cache_control": { "type": "ephemeral" } }],
        "tools": [{ "name": "exec_cmd", "description": "Run a command", "input_schema": { "type": "object" } }],
        "output_config": { "effort": "high" },
        "messages": messages,
    });
    Turn::parse(&serde_json::to_vec(&body).unwrap(), "Base instructions").unwrap()
}

fn user(text: &str) -> Value {
    json!({ "role": "user", "content": [{ "type": "text", "text": text }] })
}

fn tool_call(id: &str) -> Value {
    json!({
        "role": "assistant",
        "content": [
            { "type": "thinking", "thinking": "plan", "signature": "sig" },
            { "type": "tool_use", "id": id, "name": "exec_cmd", "input": { "cmd": "ls" } },
        ],
    })
}

fn tool_result(id: &str) -> Value {
    json!({
        "role": "user",
        "content": [{
            "type": "tool_result",
            "tool_use_id": id,
            "content": [{ "type": "text", "text": "Cargo.toml" }],
            "cache_control": { "type": "ephemeral" },
        }],
    })
}

fn live(turn: &Turn, awaiting: Awaiting) -> LiveSession {
    LiveSession {
        id: "session".to_string(),
        launch: turn.launch.clone(),
        messages: turn.hashes.clone(),
        awaiting,
    }
}

#[test]
fn parse_reads_what_claude_code_takes() {
    let turn = turn(json!([{ "role": "user", "content": "Hi" }]));

    assert_eq!(turn.system_prompt, "Base instructions\n\nWorkspace notes");
    assert_eq!(turn.launch.effort.as_deref(), Some("high"));
    assert_eq!(
        turn.tools,
        [
            json!({ "name": "exec_cmd", "description": "Run a command", "inputSchema": { "type": "object" } })
        ]
    );
    assert_eq!(turn.messages, [user("Hi")]);
}

#[test]
fn tool_results_answer_the_calls_claude_code_holds() {
    let first = turn(json!([user("List files")]));
    let session = live(&first, Awaiting::ToolResults(vec!["toolu_1".to_string()]));
    let next = turn(json!([
        user("List files"),
        tool_call("toolu_1"),
        tool_result("toolu_1")
    ]));

    let Plan::AnswerTools(results) = plan(&next, Some(&session), None, Path::new("/work")) else {
        panic!("expected tool answers");
    };
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].0, "toolu_1");
    assert_eq!(
        mcp_tool_result(&results[0].1),
        json!({ "content": [{ "type": "text", "text": "Cargo.toml" }], "isError": false })
    );
}

#[test]
fn a_finished_turn_continues_with_the_new_prompt() {
    let first = turn(json!([user("Hi")]));
    let session = live(&first, Awaiting::TurnEnd);
    let reply = json!({ "role": "assistant", "content": [{ "type": "text", "text": "Hello" }] });
    let next = turn(json!([user("Hi"), reply, user("Thanks")]));

    assert_eq!(
        plan(&next, Some(&session), None, Path::new("/work")),
        Plan::Continue(vec![json!({ "type": "text", "text": "Thanks" })])
    );
}

#[test]
fn a_saved_session_resumes_in_the_same_directory() {
    let first = turn(json!([user("Hi")]));
    let saved = SessionRecord {
        session_id: "saved".to_string(),
        model: "claude-opus-5-5".to_string(),
        cwd: PathBuf::from("/work"),
        messages: first.hashes.clone(),
    };
    let reply = json!({ "role": "assistant", "content": [{ "type": "text", "text": "Hello" }] });
    let next = turn(json!([user("Hi"), reply, user("Thanks")]));

    assert_eq!(
        plan(&next, None, Some(&saved), Path::new("/work")),
        Plan::Resume {
            session_id: "saved".to_string(),
            content: vec![json!({ "type": "text", "text": "Thanks" })],
        }
    );
    assert_eq!(
        plan(&next, None, Some(&saved), Path::new("/elsewhere")),
        Plan::Fresh
    );
}

#[test]
fn changed_history_starts_over_from_a_checkpoint() {
    let first = turn(json!([user("Hi")]));
    let session = live(&first, Awaiting::TurnEnd);
    let summary = turn(json!([user("Summary of the work"), user("Keep going")]));

    assert_eq!(
        plan(&summary, Some(&session), None, Path::new("/work")),
        Plan::Fresh
    );
}

#[test]
fn checkpoint_keeps_the_latest_prompt_and_its_images_as_content() {
    let image = json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAAA" } });
    let messages = turn(json!([
        user("List files"),
        tool_call("toolu_1"),
        tool_result("toolu_1"),
        { "role": "assistant", "content": [{ "type": "text", "text": "Done" }] },
        { "role": "user", "content": [{ "type": "text", "text": "Look" }, image] },
    ]))
    .messages;

    let content = checkpoint(&messages);

    assert_eq!(content.len(), 3);
    assert_eq!(
        content[0]["text"],
        "Sprocket recorded this conversation before you joined it. Continue it as its assistant.\n\
         <conversation-checkpoint>\n\
         <user>\nList files\n</user>\n\
         <assistant>\n<tool_call id=\"toolu_1\" name=\"exec_cmd\">{\"cmd\":\"ls\"}</tool_call>\n</assistant>\n\
         <user>\n<tool_result id=\"toolu_1\">\nCargo.toml\n</tool_result>\n</user>\n\
         <assistant>\nDone\n</assistant>\n\
         </conversation-checkpoint>"
    );
    assert_eq!(content[1], json!({ "type": "text", "text": "Look" }));
    assert_eq!(content[2], image);
}

#[test]
fn checkpoint_after_tool_results_asks_to_continue() {
    let messages = turn(json!([
        user("List files"),
        tool_call("toolu_1"),
        tool_result("toolu_1")
    ]))
    .messages;

    let content = checkpoint(&messages);

    assert_eq!(
        content.last(),
        Some(&json!({ "type": "text", "text": "Continue from the checkpoint." }))
    );
}

#[test]
fn rejected_rate_limits_report_the_subscription_limit() {
    let result = json!({ "type": "result", "is_error": true, "api_error_status": 429 });
    let info = json!({ "status": "rejected", "resetsAt": 10_000 + 2 * 3_600 });

    let error = result_error(&result, Some(&info), 10_000);

    assert_eq!(error["error"]["code"], USAGE_LIMIT_CODE);
    assert_eq!(
        error["error"]["message"],
        "Your Claude subscription's usage limit has been reached. It resets in about 2 hours. Try again after it resets, or switch to another provider."
    );
}
