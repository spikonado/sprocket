use super::*;
use rig::message::{AssistantContent, AssistantMessage, Origin};

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
fn parse_reads_what_the_cli_takes() {
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
fn tool_results_answer_the_calls_the_cli_holds() {
    let first = turn(json!([user("List files")]));
    let session = live(&first, Awaiting::ToolResults(vec!["toolu_1".to_string()]));
    let next = turn(json!([
        user("List files"),
        tool_call("toolu_1"),
        tool_result("toolu_1")
    ]));

    let Plan::AnswerTools(results) = plan(&next, Some(&session), None) else {
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
        plan(&next, Some(&session), None),
        Plan::Continue(vec![json!({ "type": "text", "text": "Thanks" })])
    );
}

#[test]
fn the_latest_reply_names_the_session_to_resume() {
    const SESSION: &str = "6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
    let reply = |response_id: &str| {
        let mut origin = Origin::new("anthropic", "anthropic", "claude-opus-5-5");
        origin.response_id = Some(response_id.to_string());
        Message::Assistant(
            AssistantMessage::new(vec![AssistantContent::text("Hello")]).with_origin(origin),
        )
    };
    let resume = resume_point(&[reply("msg_old"), reply(SESSION), Message::user("Thanks")])
        .expect("the latest reply names a session");
    assert_eq!(resume_point(&[reply(SESSION), reply("msg_other")]), None);

    let reply = json!({ "role": "assistant", "content": [{ "type": "text", "text": "Hello" }] });
    let next = turn(json!([user("Hi"), reply, user("Thanks")]));
    let after_tools = turn(json!([
        user("Hi"),
        tool_call("call"),
        tool_result("call"),
        user("Thanks")
    ]));

    assert_eq!(
        plan(&next, None, Some(&resume)),
        Plan::Resume {
            session_id: SESSION.to_string(),
            content: vec![json!({ "type": "text", "text": "Thanks" })],
        }
    );
    assert_eq!(
        plan(&after_tools, None, Some(&resume)),
        Plan::Resume {
            session_id: SESSION.to_string(),
            content: vec![
                json!({ "type": "text", "text": "Sprocket recorded these results for your tool calls:\n<tool_result id=\"call\">\nCargo.toml\n</tool_result>\n" }),
                json!({ "type": "text", "text": "Thanks" }),
            ],
        }
    );
}

#[test]
fn changed_history_starts_over_from_a_checkpoint() {
    let first = turn(json!([user("Hi")]));
    let session = live(&first, Awaiting::TurnEnd);
    let summary = turn(json!([user("Summary of the work"), user("Keep going")]));

    assert_eq!(plan(&summary, Some(&session), None), Plan::Fresh);
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
fn mcp_tool_calls_wait_for_sprocket() {
    let params = json!({ "name": "exec_cmd", "arguments": { "cmd": "ls" } });
    let call = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": params });
    let notification = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });

    assert_eq!(
        mcp_reply(&call, &[]),
        McpReply::ToolCall {
            rpc_id: json!(2),
            params,
        }
    );
    assert_eq!(mcp_reply(&notification, &[]), McpReply::Ack);
}
