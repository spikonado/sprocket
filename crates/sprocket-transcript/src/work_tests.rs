use serde_json::json;

use super::{TranscriptPart, WorkReplica};

fn completion_part(number: u32, items: Vec<serde_json::Value>) -> TranscriptPart {
    serde_json::from_value(json!({
        "number": number,
        "sourceKey": format!("completion:run:{number}"),
        "kind": "completion",
        "runId": "run",
        "completion": { "items": items }
    }))
    .unwrap()
}

fn tool_part(
    number: u32,
    invocation: &str,
    status: &str,
    output: serde_json::Value,
) -> TranscriptPart {
    let mut part = completion_part(number, Vec::new());
    part.source_key = format!("tool:{invocation}:{status}:{number}");
    part.kind = super::TranscriptPartKind::Tool;
    part.completion = None;
    part.tool = Some(super::types::TranscriptToolBody {
        job_id: None,
        tool_invocation_id: Some(invocation.into()),
        call_id: "repeated".into(),
        name: "read_file".into(),
        input: None,
        output: Some(output),
        status: status.into(),
    });
    part
}

#[test]
fn late_text_splits_a_closed_block_and_refreshes_its_details() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    replica
        .save_parts(
            "thread",
            &[
                completion_part(0, vec![json!({"type":"reasoning","text":"first"})]),
                completion_part(
                    2,
                    vec![
                        json!({"type":"reasoning","text":"second"}),
                        json!({"type":"text","text":"done"}),
                    ],
                ),
            ],
        )
        .unwrap();
    let id = "work:run:completion:run:0:0";
    let before = replica.page(None, 10, None, &[], false).unwrap();
    let old_row = before["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == id)
        .unwrap();
    let details = replica.details(id, None, None, true, 10, false).unwrap();
    assert_eq!(details["parts"].as_array().unwrap().len(), 2);

    replica
        .save_parts(
            "thread",
            &[completion_part(
                1,
                vec![json!({"type":"text","text":"between"})],
            )],
        )
        .unwrap();
    let after = replica.page(None, 10, None, &[], false).unwrap();
    let row = after["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == id)
        .unwrap();
    assert_eq!(row["closed"], true);
    assert!(row["revision"].as_u64().unwrap() > old_row["revision"].as_u64().unwrap());
    let details = replica.details(id, None, None, true, 10, false).unwrap();
    assert_eq!(details["parts"].as_array().unwrap().len(), 1);
    assert_eq!(details["parts"][0]["text"], "first");
    let details = replica
        .details("work:run:completion:run:2:0", None, None, true, 10, false)
        .unwrap();
    assert_eq!(details["parts"][0]["text"], "second");
}

#[test]
fn newest_first_parts_converge_to_one_section() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    replica.set_remote_total(2).unwrap();
    let later = completion_part(
        1,
        vec![json!({"type":"reasoning","text":"later","startedAt":30,"completedAt":40})],
    );
    replica.save_parts("thread", &[later]).unwrap();
    let page = replica
        .page(
            None,
            10,
            None,
            &[("run".into(), "1".into()), ("run".into(), "live".into())],
            false,
        )
        .unwrap();
    assert_eq!(page["indexing"], false);
    assert_eq!(page["syncing"], true);
    assert_eq!(page["rows"].as_array().unwrap().len(), 1);
    assert_eq!(
        page["rows"][0]["sequence"],
        super::sections::POSITION_STRIDE
    );
    assert_eq!(
        page["persistedStreams"],
        json!([{"runId":"run","streamId":"1"}])
    );
    let next = page["nextBefore"].as_u64().unwrap();
    let older = replica.page(Some(next), 10, None, &[], false).unwrap();
    assert_eq!(older["indexing"], true);
    assert_eq!(older["syncing"], true);
    let first = completion_part(
        0,
        vec![json!({"type":"reasoning","text":"first","startedAt":10,"completedAt":20})],
    );
    replica.save_parts("thread", &[first]).unwrap();

    let page = replica.page(None, 10, None, &[], false).unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 1);
    assert_eq!(page["rows"][0]["sequence"], 0);
    assert_eq!(page["rows"][0]["id"], "work:run:completion:run:0:0");
    assert_eq!(page["syncing"], false);
    let details = replica
        .details(
            page["rows"][0]["id"].as_str().unwrap(),
            None,
            None,
            true,
            10,
            false,
        )
        .unwrap();
    assert_eq!(details["parts"].as_array().unwrap().len(), 2);
}

#[test]
fn started_parts_remain_stored_but_running_requires_a_canonical_call() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    let mut event = tool_part(0, "invocation", "started", json!(null));
    event.created_at = Some(10);
    let tool = event.tool.as_mut().unwrap();
    tool.call_id = "call".into();
    tool.name = "poll_cmd".into();
    tool.input = Some(json!({"sessionId":"stored-session"}));
    tool.output = None;
    replica.save_parts("thread", &[event.clone()]).unwrap();
    assert_eq!(
        replica.page(None, 10, None, &[], false).unwrap()["rows"],
        json!([])
    );
    assert_eq!(replica.part(0).unwrap(), Some(event));
    let completion = completion_part(
        1,
        vec![
            json!({"type":"tool-call","callId":"call","toolInvocationId":"invocation","name":"poll_cmd","input":{"sessionId":"canonical-session"}}),
        ],
    );
    replica.save_parts("thread", &[completion]).unwrap();
    let page = replica.page(None, 10, None, &[], false).unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 1);
    assert_eq!(page["rows"][0]["closed"], false);
    assert_eq!(page["rows"][0]["toolCounts"], json!({"poll_cmd":1}));
    assert_eq!(page["rows"][0]["unpersistedToolCallIds"], json!(["call"]));
    let details = replica
        .details(
            page["rows"][0]["id"].as_str().unwrap(),
            None,
            None,
            true,
            10,
            false,
        )
        .unwrap();
    assert_eq!(details["parts"].as_array().unwrap().len(), 1);
    assert_eq!(details["parts"][0]["callId"], "call");
    assert_eq!(
        details["parts"][0]["input"],
        json!({"sessionId":"canonical-session"})
    );
}

#[test]
fn orphan_command_details_use_terminal_input_and_ignore_started_input() {
    let input = json!({"sessionId":"session","action":"terminate"});
    for (started_input, finished_input, has_invocation) in [
        (
            Some(input.clone()),
            Some(json!({"sessionId":"other"})),
            true,
        ),
        (None, Some(input.clone()), true),
        (None, None, true),
        (None, Some(input), false),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
        let output = json!({"error":"session unavailable"});
        let mut started = tool_part(0, "control", "started", json!(null));
        let tool = started.tool.as_mut().unwrap();
        tool.name = "control_cmd".into();
        tool.input = started_input.clone();
        if !has_invocation {
            tool.tool_invocation_id = None;
        }
        let mut finished = tool_part(1, "control", "failed", output.clone());
        let tool = finished.tool.as_mut().unwrap();
        tool.name = "control_cmd".into();
        tool.input = finished_input.clone();
        if !has_invocation {
            tool.tool_invocation_id = None;
        }
        replica.save_parts("thread", &[started, finished]).unwrap();

        let page = replica.page(None, 10, None, &[], false).unwrap();
        assert_eq!(page["rows"].as_array().unwrap().len(), 1);
        let details = replica
            .details(
                page["rows"][0]["id"].as_str().unwrap(),
                None,
                None,
                true,
                10,
                false,
            )
            .unwrap();
        let parts = details["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["type"], "tool-call");
        assert_eq!(parts[0]["name"], "control_cmd");
        assert_eq!(
            parts[0].get("input"),
            Some(&finished_input.unwrap_or(json!(null)))
        );
        assert_eq!(parts[1]["type"], "tool-result");
        assert_eq!(parts[1]["output"], output);
    }
}

#[test]
fn artifact_calls_and_results_appear_in_work_details() {
    for name in [
        "bind_artifact",
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
        assert_eq!(page["rows"], json!([]), "{name}");
        let completion = completion_part(
            1,
            vec![
                json!({"type":"tool-call","callId":"repeated","toolInvocationId":"artifact","name":name,"input":{}}),
            ],
        );
        let mut finished = tool_part(2, "artifact", "completed", json!({"artifacts":[]}));
        finished.tool.as_mut().unwrap().name = name.into();
        replica
            .save_parts("thread", &[completion, finished])
            .unwrap();
        let page = replica.page(None, 10, None, &[], false).unwrap();
        assert_eq!(page["rows"][0]["toolCounts"][name], 1, "{name}");
        assert_eq!(
            page["rows"][0]["unpersistedToolCallIds"],
            json!([]),
            "{name}"
        );
        let details = replica
            .details(
                page["rows"][0]["id"].as_str().unwrap(),
                None,
                None,
                true,
                10,
                false,
            )
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
    let completion = completion_part(
        0,
        vec![
            json!({"type":"tool-call","callId":"repeated","toolInvocationId":"invocation-one","name":"read_file","input":{"path":"one"}}),
            json!({"type":"tool-call","callId":"repeated","toolInvocationId":"invocation-two","name":"read_file","input":{"path":"two"}}),
        ],
    );
    replica.save_parts("thread", &[completion]).unwrap();
    let revision = replica.page(None, 10, None, &[], false).unwrap()["rows"][0]["revision"].clone();
    replica
        .save_parts(
            "thread",
            &[
                tool_part(1, "invocation-two", "completed", json!({"value":"two"})),
                tool_part(2, "invocation-one", "completed", json!({"value":"one"})),
            ],
        )
        .unwrap();
    assert_ne!(
        replica.page(None, 10, None, &[], false).unwrap()["rows"][0]["revision"],
        revision
    );

    let details = replica
        .details("work:run:completion:run:0:0", None, None, true, 10, false)
        .unwrap();
    assert_eq!(details["parts"][1]["output"]["value"], "one");
    assert_eq!(details["parts"][3]["output"]["value"], "two");
}

#[test]
fn canonical_call_runs_without_any_tool_event_and_settles_on_terminal_result() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    let completion = completion_part(
        0,
        vec![
            json!({"type":"tool-call","callId":"repeated","toolInvocationId":"one","name":"read_file","input":{"path":"one"}}),
        ],
    );
    replica.save_parts("thread", &[completion]).unwrap();
    let page = replica.page(None, 10, None, &[], false).unwrap();
    let id = page["rows"][0]["id"].as_str().unwrap();
    assert_eq!(
        page["rows"][0]["unpersistedToolCallIds"],
        json!(["repeated"])
    );
    assert_eq!(page["rows"][0]["closed"], false);
    let details = replica.details(id, None, None, true, 10, false).unwrap();
    assert_eq!(details["parts"].as_array().unwrap().len(), 1);
    assert_eq!(details["parts"][0]["input"], json!({"path":"one"}));

    let result: TranscriptPart = serde_json::from_value(json!({
        "number":1, "sourceKey":"tool:one:completed", "kind":"tool", "runId":"run",
        "tool":{"toolInvocationId":"one", "status":"completed", "output":{"content":"one"}}
    }))
    .unwrap();
    replica.save_parts("thread", &[result]).unwrap();
    let page = replica.page(None, 10, None, &[], false).unwrap();
    assert_eq!(page["rows"][0]["id"], id);
    assert_eq!(page["rows"][0]["unpersistedToolCallIds"], json!([]));
    assert_eq!(page["rows"][0]["closed"], false);
    let details = replica.details(id, None, None, true, 10, false).unwrap();
    assert_eq!(details["parts"].as_array().unwrap().len(), 2);
    assert_eq!(details["parts"][1]["callId"], "repeated");
    assert_eq!(details["parts"][1]["name"], "read_file");
    assert_eq!(details["parts"][1]["status"], "completed");
    assert_eq!(details["parts"][1]["output"], json!({"content":"one"}));
}

#[test]
fn newest_first_result_joins_its_call_and_earlier_reasoning() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    let result = tool_part(2, "one", "completed", json!({"content":"one"}));
    replica.save_parts("thread", &[result]).unwrap();
    let orphan = replica.page(None, 10, None, &[], false).unwrap();
    let orphan_id = orphan["rows"][0]["id"].as_str().unwrap();
    assert_eq!(orphan_id, "work:run:tool:one:completed:2:0");

    let call = completion_part(
        1,
        vec![
            json!({"type":"tool-call","callId":"repeated","toolInvocationId":"one","name":"read_file","input":{"path":"one"}}),
            json!({"type":"text","text":"Done."}),
        ],
    );
    replica.save_parts("thread", &[call]).unwrap();
    let with_call = replica.page(None, 10, None, &[], false).unwrap();
    assert_eq!(with_call["rows"].as_array().unwrap().len(), 2);
    assert_eq!(with_call["rows"][0]["id"], "work:run:completion:run:1:0");

    let reasoning = completion_part(0, vec![json!({"type":"reasoning","text":"Checking."})]);
    replica.save_parts("thread", &[reasoning]).unwrap();
    let joined = replica
        .page(
            None,
            10,
            Some((orphan["revision"].as_u64().unwrap(), -1)),
            &[],
            false,
        )
        .unwrap();
    assert_eq!(joined["rows"].as_array().unwrap().len(), 2);
    assert_eq!(joined["rows"][0]["id"], "work:run:completion:run:0:0");
    assert_eq!(joined["rows"][0]["toolCounts"], json!({"read_file":1}));
    assert_eq!(joined["rows"][0]["unpersistedToolCallIds"], json!([]));
    assert_eq!(joined["rows"][0]["closed"], true);
    assert!(
        joined["changes"]
            .as_array()
            .unwrap()
            .contains(&json!({"id":orphan_id,"row":null}))
    );
    let details = replica
        .details(
            joined["rows"][0]["id"].as_str().unwrap(),
            None,
            None,
            true,
            10,
            false,
        )
        .unwrap();
    assert_eq!(details["parts"].as_array().unwrap().len(), 3);
    assert_eq!(details["parts"][0]["text"], "Checking.");
    assert_eq!(details["parts"][1]["input"], json!({"path":"one"}));
    assert_eq!(details["parts"][2]["output"], json!({"content":"one"}));
}

#[test]
fn whitespace_does_not_open_or_close_work_blocks() {
    let parts = [
        completion_part(
            0,
            vec![
                json!({"type":"reasoning","text":" \n\t"}),
                json!({"type":"text","text":" \n"}),
                json!({"type":"reasoning","text":"Checking."}),
                json!({"type":"text","text":"\t"}),
                json!({"type":"tool-call","callId":"call","name":"read_file"}),
            ],
        ),
        completion_part(
            1,
            vec![
                json!({"type":"reasoning","text":"Still checking."}),
                json!({"type":"text","text":"Done."}),
            ],
        ),
    ];
    let blocks = super::sections::derive_work_blocks(&parts);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].id, "work:run:completion:run:0:2");
    assert!(blocks[0].closed);

    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    replica.save_parts("thread", &parts).unwrap();
    let page = replica.page(None, 10, None, &[], false).unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 2);
    assert_eq!(page["rows"][0]["id"], blocks[0].id);
    assert_eq!(page["rows"][0]["closed"], blocks[0].closed);
    assert_eq!(page["rows"][1]["text"], "Done.");
    let details = replica
        .details(&blocks[0].id, None, None, true, 10, false)
        .unwrap();
    assert_eq!(details["parts"].as_array().unwrap().len(), 3);
    assert_eq!(details["parts"][0]["text"], "Checking.");
    assert_eq!(details["parts"][1]["type"], "tool-call");
    assert_eq!(details["parts"][2]["text"], "Still checking.");
}

fn command_snapshot_parts(poll_running: bool) -> Vec<TranscriptPart> {
    let call = completion_part(
        0,
        vec![
            json!({"type":"tool-call","callId":"exec","toolInvocationId":"exec","name":"exec_command","input":{"cmd":"cargo test"},"startedAt":10}),
            json!({"type":"text","text":"Checking something else while the tests run.","startedAt":20}),
        ],
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
    let poll = completion_part(
        2,
        vec![
            json!({"type":"tool-call","callId":"poll","toolInvocationId":"poll","name":"write_stdin","input":{"sessionId":"7"},"startedAt":30}),
        ],
    );
    let mut polled = tool_part(
        3,
        "poll",
        "completed",
        json!({"running":poll_running,"success":!poll_running,"output":"More test output\n"}),
    );
    polled.created_at = Some(50);
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
            assert_eq!(initial["closed"], true);
            let initial_id = initial["id"].as_str().unwrap();
            let initial_details = replica
                .details(initial_id, None, None, true, 10, false)
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
            assert_eq!(page["rows"][2]["id"], "work:run:completion:run:2:0");
            assert_eq!(
                replica
                    .details(initial_id, None, None, true, 10, false)
                    .unwrap()["parts"],
                initial_details
            );
            let poll_details = replica
                .details(
                    page["rows"][2]["id"].as_str().unwrap(),
                    None,
                    None,
                    true,
                    10,
                    false,
                )
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
        }
    }
}

#[test]
fn replica_opens_in_wal_mode() {
    let dir = tempfile::tempdir().unwrap();
    let replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    let journal: String = replica
        .db
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    assert_eq!(journal.to_ascii_lowercase(), "wal");
}

#[test]
fn caches_from_other_schema_versions_rebuild_on_open() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    replica
        .save_parts("thread", &command_snapshot_parts(false))
        .unwrap();
    let identity: String = replica.state("replicaId").unwrap().unwrap();
    replica.db.execute_batch("PRAGMA user_version=0;").unwrap();
    drop(replica);

    let replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    assert_ne!(
        replica.state::<String>("replicaId").unwrap().unwrap(),
        identity
    );
    assert_eq!(replica.part(0).unwrap(), None);
    assert_eq!(
        replica.page(None, 10, None, &[], false).unwrap()["rows"],
        json!([])
    );
}

#[test]
fn emptied_sections_reach_the_change_feed_as_deletions() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    replica
        .save_parts("thread", &[tool_part(0, "one", "completed", json!({}))])
        .unwrap();
    let before = replica.page(None, 10, None, &[], false).unwrap();
    let orphan_id = before["rows"][0]["id"].as_str().unwrap();
    assert_eq!(orphan_id, "work:run:tool:one:completed:0:0");

    let completion = completion_part(
        1,
        vec![
            json!({"type":"tool-call","callId":"repeated","toolInvocationId":"one","name":"read_file"}),
        ],
    );
    replica.save_parts("thread", &[completion]).unwrap();
    let page = replica
        .page(
            None,
            10,
            Some((before["revision"].as_u64().unwrap(), -1)),
            &[],
            false,
        )
        .unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 1);
    assert_eq!(page["rows"][0]["id"], "work:run:completion:run:1:0");
    assert!(
        page["changes"]
            .as_array()
            .unwrap()
            .contains(&json!({"id":orphan_id,"row":null}))
    );
}

#[test]
fn tool_counts_follow_displayed_calls_in_both_download_orders() {
    let completion = completion_part(
        0,
        vec![
            json!({"type":"reasoning","text":"checking files","name":"not-a-tool"}),
            json!({"type":"tool-call","callId":"repeated","toolInvocationId":"one","name":"read_file"}),
            json!({"type":"tool-call","callId":"repeated","toolInvocationId":"two","name":"read_file"}),
            json!({"type":"tool-call","name":"list_artifacts"}),
            json!({"type":"tool-result","callId":"repeated","name":"not-a-call"}),
        ],
    );
    let started = tool_part(1, "one", "started", json!(null));
    let mut failed = tool_part(2, "one", "failed", json!({"error":"missing"}));
    failed.tool.as_mut().unwrap().name = "result-name".into();
    let mut poll = tool_part(3, "poll", "started", json!(null));
    poll.tool.as_mut().unwrap().name = "poll_cmd".into();
    let mut poll_finished = tool_part(4, "poll", "completed", json!({"running":false}));
    poll_finished.tool.as_mut().unwrap().name = "poll_cmd".into();
    let mut terminal_only = tool_part(5, "terminal-only", "failed", json!({"error":"failed"}));
    terminal_only.tool.as_mut().unwrap().name = "control_cmd".into();
    let parts = [
        completion,
        started,
        failed,
        poll,
        poll_finished,
        terminal_only,
    ];
    for newest_first in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
        let ordered: Vec<_> = if newest_first {
            parts.iter().rev().cloned().collect()
        } else {
            parts.to_vec()
        };
        for part in ordered {
            replica.save_parts("thread", &[part]).unwrap();
        }
        let page = replica.page(None, 10, None, &[], false).unwrap();
        assert_eq!(page["rows"].as_array().unwrap().len(), 3);
        assert_eq!(
            page["rows"][0]["unpersistedToolCallIds"],
            json!(["repeated"])
        );
        assert_eq!(
            page["rows"][0]["toolCounts"],
            json!({"read_file":2,"list_artifacts":1})
        );
        assert_eq!(page["rows"][1]["toolCounts"], json!({"poll_cmd":1}));
        assert_eq!(page["rows"][2]["toolCounts"], json!({"control_cmd":1}));
    }
}

#[test]
fn terminal_fallback_is_replaced_when_its_canonical_call_arrives() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    let started = tool_part(0, "one", "started", json!(null));
    replica.save_parts("thread", &[started]).unwrap();
    let page = replica.page(None, 10, None, &[], false).unwrap();
    assert_eq!(page["rows"], json!([]));

    let terminal = tool_part(1, "one", "completed", json!({}));
    replica.save_parts("thread", &[terminal]).unwrap();
    let page = replica.page(None, 10, None, &[], false).unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 1);
    assert_eq!(page["rows"][0]["id"], "work:run:tool:one:completed:1:0");
    assert_eq!(page["rows"][0]["unpersistedToolCallIds"], json!([]));

    let completion = completion_part(
        2,
        vec![
            json!({"type":"tool-call","callId":"repeated","toolInvocationId":"one","name":"read_file"}),
        ],
    );
    replica.save_parts("thread", &[completion]).unwrap();
    let page = replica.page(None, 10, None, &[], false).unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 1);
    assert_eq!(page["rows"][0]["id"], "work:run:completion:run:2:0");
    assert_eq!(page["rows"][0]["toolCounts"], json!({"read_file":1}));
    assert_eq!(page["rows"][0]["unpersistedToolCallIds"], json!([]));
}

#[test]
fn tool_counts_split_one_completion_across_sections() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    let completion = completion_part(
        0,
        vec![
            json!({"type":"tool-call","callId":"call-0","name":"exec_cmd"}),
            json!({"type":"text","text":"First command finished."}),
            json!({"type":"tool-call","callId":"call-1","name":"exec_cmd"}),
            json!({"type":"tool-call","callId":"call-2","name":"exec_cmd"}),
            json!({"type":"tool-call","callId":"call-3","name":"exec_cmd"}),
        ],
    );
    replica.save_parts("thread", &[completion]).unwrap();
    let rows = &replica.page(None, 10, None, &[], false).unwrap()["rows"];
    assert_eq!(rows.as_array().unwrap().len(), 3);
    assert_eq!(rows[0]["toolCounts"], json!({"exec_cmd":1}));
    assert_eq!(rows[0]["closed"], true);
    assert_eq!(rows[2]["id"], "work:run:completion:run:0:2");
    assert_eq!(rows[2]["toolCounts"], json!({"exec_cmd":3}));
    assert_eq!(rows[2]["closed"], false);
}
