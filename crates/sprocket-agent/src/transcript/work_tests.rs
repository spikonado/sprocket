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
