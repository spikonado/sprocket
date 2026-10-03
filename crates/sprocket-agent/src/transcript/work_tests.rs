use serde_json::json;

use super::{TranscriptPart, WorkReplica};

fn assigned_part(
    number: u32,
    items: Vec<serde_json::Value>,
    work: serde_json::Value,
) -> TranscriptPart {
    serde_json::from_value(json!({
        "number": number,
        "sourceKey": format!("completion:run:{number}"),
        "kind": "completion",
        "runId": "run",
        "completion": { "streamId": number.to_string(), "items": items },
        "work": work
    }))
    .unwrap()
}

fn tool_part(
    number: u32,
    invocation: &str,
    status: &str,
    output: serde_json::Value,
) -> TranscriptPart {
    let mut part = assigned_part(
        number,
        Vec::new(),
        json!({"ranges":[],"sectionKey":"section"}),
    );
    part.kind = super::TranscriptPartKind::Tool;
    part.completion = None;
    part.tool = Some(super::types::TranscriptToolBody {
        job_id: None,
        tool_invocation_id: Some(invocation.into()),
        call_id: "repeated".into(),
        name: "read_file".into(),
        output: Some(output),
        status: status.into(),
    });
    part
}

#[test]
fn newest_first_parts_converge_to_one_section() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    replica.set_remote_total(2).unwrap();
    let later = assigned_part(
        1,
        vec![json!({"type":"reasoning","text":"later","startedAt":30,"completedAt":40})],
        json!({"ranges":[{"start":0,"end":1,"sectionKey":"section"}]}),
    );
    replica.save_parts("thread", &[later]).unwrap();
    let first = assigned_part(
        0,
        vec![json!({"type":"reasoning","text":"first","startedAt":10,"completedAt":20})],
        json!({"ranges":[{"start":0,"end":1,"sectionKey":"section"}]}),
    );
    replica.save_parts("thread", &[first]).unwrap();

    let page = replica.page(None, 10, None, &[], false).unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 1);
    assert_eq!(page["rows"][0]["itemCount"], 2);
    let details = replica
        .details("section", None, None, true, 10, false)
        .unwrap();
    assert_eq!(details["parts"].as_array().unwrap().len(), 2);
}

#[test]
fn tool_event_before_completion_is_visible_and_then_pairs_with_the_call() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    let event = assigned_part(0, Vec::new(), json!({"ranges":[],"sectionKey":"section"}));
    let mut event = TranscriptPart {
        kind: super::TranscriptPartKind::Tool,
        tool: Some(super::types::TranscriptToolBody {
            job_id: None,
            tool_invocation_id: Some("invocation".into()),
            call_id: "call".into(),
            name: "read_file".into(),
            output: None,
            status: "started".into(),
        }),
        ..event
    };
    event.created_at = Some(10);
    replica.save_parts("thread", &[event]).unwrap();
    assert_eq!(
        replica.page(None, 10, None, &[], false).unwrap()["rows"][0]["pendingTools"],
        1
    );

    let completion = assigned_part(
        1,
        vec![json!({"type":"tool-call","callId":"call","name":"read_file","input":{}})],
        json!({
            "ranges":[{"start":0,"end":1,"sectionKey":"section"}],
            "toolInvocations":[{"item":0,"toolInvocationId":"invocation"}]
        }),
    );
    replica.save_parts("thread", &[completion]).unwrap();
    let details = replica
        .details("section", None, None, true, 10, false)
        .unwrap();
    assert_eq!(details["parts"].as_array().unwrap().len(), 1);
    assert_eq!(details["parts"][0]["callId"], "call");
}

#[test]
fn artifact_calls_and_results_appear_in_work_details() {
    for name in [
        "add_artifact",
        "list_artifacts",
        "edit_artifact",
        "save_artifact",
        "delete_artifact",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
        let mut started = tool_part(0, "artifact", "started", json!(null));
        started.tool.as_mut().unwrap().name = name.into();
        replica.save_parts("thread", &[started]).unwrap();
        let page = replica.page(None, 10, None, &[], false).unwrap();
        assert_eq!(page["rows"][0]["pendingTools"], 1, "{name}");
        let completion = assigned_part(
            1,
            vec![json!({"type":"tool-call","callId":"repeated","name":name,"input":{}})],
            json!({"ranges":[{"start":0,"end":1,"sectionKey":"section"}],
                "toolInvocations":[{"item":0,"toolInvocationId":"artifact"}]}),
        );
        let mut finished = tool_part(2, "artifact", "completed", json!({"artifacts":[]}));
        finished.tool.as_mut().unwrap().name = name.into();
        replica
            .save_parts("thread", &[completion, finished])
            .unwrap();
        let page = replica.page(None, 10, None, &[], false).unwrap();
        assert_eq!(page["rows"][0]["itemCount"], 1, "{name}");
        assert_eq!(page["rows"][0]["pendingTools"], 0, "{name}");
        let details = replica
            .details("section", None, None, true, 10, false)
            .unwrap();
        let parts = details["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2, "{name}");
        assert_eq!(parts[0]["type"], "tool-call");
        assert_eq!(parts[0]["name"], name);
        assert_eq!(parts[1]["type"], "tool-result");
        assert_eq!(parts[1]["output"], json!({"artifacts":[]}));
    }
}

#[test]
fn repeated_call_ids_pair_by_invocation_when_results_finish_out_of_order() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    let completion = assigned_part(
        0,
        vec![
            json!({"type":"tool-call","callId":"repeated","name":"read_file","input":{"path":"one"}}),
            json!({"type":"tool-call","callId":"repeated","name":"read_file","input":{"path":"two"}}),
        ],
        json!({
            "ranges":[{"start":0,"end":2,"sectionKey":"section"}],
            "toolInvocations":[
                {"item":0,"toolInvocationId":"invocation-one"},
                {"item":1,"toolInvocationId":"invocation-two"}
            ]
        }),
    );
    replica.save_parts("thread", &[completion]).unwrap();
    replica
        .save_parts(
            "thread",
            &[
                tool_part(1, "invocation-two", "completed", json!({"value":"two"})),
                tool_part(2, "invocation-one", "completed", json!({"value":"one"})),
            ],
        )
        .unwrap();

    let details = replica
        .details("section", None, None, true, 10, false)
        .unwrap();
    assert_eq!(details["parts"][1]["output"]["value"], "one");
    assert_eq!(details["parts"][3]["output"]["value"], "two");
}

fn command_snapshot_parts(poll_running: bool) -> Vec<TranscriptPart> {
    let call = assigned_part(
        0,
        vec![
            json!({"type":"tool-call","callId":"exec","name":"exec_command","input":{"cmd":"cargo test"},"startedAt":10}),
            json!({"type":"text","text":"Checking something else while the tests run.","startedAt":20}),
        ],
        json!({"ranges":[{"start":0,"end":1,"sectionKey":"section"}],
            "toolInvocations":[{"item":0,"toolInvocationId":"exec"}]}),
    );
    let mut yielded = tool_part(
        1,
        "exec",
        "completed",
        json!({"sessionId":"7","running":true,"success":false,"output":"Starting tests\n"}),
    );
    yielded.created_at = Some(20);
    let tool = yielded.tool.as_mut().unwrap();
    tool.call_id = "exec".into();
    tool.name = "exec_command".into();
    let poll = assigned_part(
        2,
        vec![
            json!({"type":"tool-call","callId":"poll","name":"write_stdin","input":{"sessionId":"7"},"startedAt":30}),
        ],
        json!({"ranges":[{"start":0,"end":1,"sectionKey":"poll-section"}],
            "toolInvocations":[{"item":0,"toolInvocationId":"poll"}]}),
    );
    let mut polled = tool_part(
        3,
        "poll",
        "completed",
        json!({"running":poll_running,"success":!poll_running,"output":"More test output\n"}),
    );
    polled.created_at = Some(50);
    polled.work.section_key = Some("poll-section".into());
    let tool = polled.tool.as_mut().unwrap();
    tool.call_id = "poll".into();
    tool.name = "write_stdin".into();
    vec![call, yielded, poll, polled]
}

#[test]
fn command_calls_settle_on_their_own_snapshot_results() {
    for poll_running in [true, false] {
        for newest_first in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
            let parts = command_snapshot_parts(poll_running);
            replica.save_parts("thread", &parts[..2]).unwrap();
            let initial = replica.page(None, 10, None, &[], false).unwrap()["rows"][0].clone();
            assert_eq!(initial["pendingTools"], 0);
            assert_eq!(initial["closed"], true);
            assert_eq!(initial["completedAt"], 20.0);
            let initial_details = replica
                .details("section", None, None, true, 10, false)
                .unwrap()["parts"]
                .clone();
            assert_eq!(
                initial_details[1]["output"],
                parts[1]
                    .tool
                    .as_ref()
                    .unwrap()
                    .output
                    .as_ref()
                    .unwrap()
                    .clone()
            );

            let later: Vec<_> = if newest_first {
                parts[2..].iter().rev().cloned().collect()
            } else {
                parts[2..].to_vec()
            };
            for part in later {
                replica.save_parts("thread", &[part]).unwrap();
            }
            let page = replica.page(None, 10, None, &[], false).unwrap();
            assert_eq!(page["rows"][0], initial);
            assert_eq!(page["rows"][2]["pendingTools"], 0);
            assert_eq!(page["rows"][2]["completedAt"], 50.0);
            assert_eq!(
                replica
                    .details("section", None, None, true, 10, false)
                    .unwrap()["parts"],
                initial_details
            );
            let poll_details = replica
                .details("poll-section", None, None, true, 10, false)
                .unwrap();
            assert_eq!(
                poll_details["parts"][1]["output"],
                parts[3]
                    .tool
                    .as_ref()
                    .unwrap()
                    .output
                    .as_ref()
                    .unwrap()
                    .clone()
            );
            assert_eq!(poll_details["parts"][1]["completedAt"], 50.0);
        }
    }
}

#[test]
fn old_command_session_caches_migrate_without_losing_transcript_data() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    let parts = command_snapshot_parts(false);
    replica.save_parts("thread", &parts).unwrap();
    replica.set_remote_total(6).unwrap();
    let before = replica.page(None, 10, None, &[], false).unwrap();
    drop(replica);

    let db = rusqlite::Connection::open(dir.path().join("history.sqlite3")).unwrap();
    let identity: String = db
        .query_row("SELECT value FROM state WHERE key='replicaId'", [], |row| {
            row.get(0)
        })
        .unwrap();
    db.execute_batch(
        "ALTER TABLE source_refs ADD COLUMN session TEXT;
        UPDATE sections SET body=json_set(body,'$.pendingTools',1,'$.completedAt',100) WHERE key='section';
        UPDATE rows SET body=json_set(body,'$.pendingTools',1,'$.completedAt',100) WHERE id='section';
        DELETE FROM source_refs;",
    ).unwrap();
    drop(db);

    let replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    for part in &parts {
        assert_eq!(replica.part(part.number).unwrap().unwrap(), *part);
    }
    let page = replica
        .page(
            None,
            10,
            Some((before["revision"].as_u64().unwrap(), -1)),
            &[],
            false,
        )
        .unwrap();
    assert_eq!(page["rows"][0]["pendingTools"], 0);
    assert_eq!(page["rows"][0]["completedAt"], 20.0);
    assert_eq!(page["rows"][0]["closed"], before["rows"][0]["closed"]);
    assert_eq!(page["rows"][2]["closed"], before["rows"][2]["closed"]);
    assert_eq!(page["changes"][0]["id"], "section");
    assert_eq!(
        replica
            .details("section", None, None, true, 10, false)
            .unwrap()["parts"][1]["output"]["running"],
        true
    );
    drop(replica);

    let db = rusqlite::Connection::open(dir.path().join("history.sqlite3")).unwrap();
    assert_eq!(
        db.query_row("SELECT value FROM state WHERE key='replicaId'", [], |row| {
            row.get::<_, String>(0)
        })
        .unwrap(),
        identity
    );
    assert_eq!(
        db.query_row("SELECT value FROM state WHERE key='total'", [], |row| {
            row.get::<_, String>(0)
        })
        .unwrap(),
        "6"
    );
    assert_eq!(
        db.query_row("SELECT end FROM coverage WHERE start=0", [], |row| row
            .get::<_, u32>(0))
            .unwrap(),
        3
    );
    assert!(
        !db.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('source_refs') WHERE name='session')",
            [],
            |row| row.get::<_, bool>(0)
        )
        .unwrap()
    );
    drop(db);
    let reopened = WorkReplica::open(dir.path().to_owned()).unwrap();
    assert_eq!(
        reopened.page(None, 10, None, &[], false).unwrap()["revision"],
        page["revision"]
    );
}
