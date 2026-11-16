use super::*;

#[test]
fn cloud_job_snapshot_decodes_returned_result_part() {
    let snapshot: ExecutorJobSnapshot = serde_json::from_value(serde_json::json!({
        "status": "completed",
        "result": {"results": []},
        "part": {
            "number": 3, "sourceKey": "tool:search:finished", "kind": "tool", "runId": "run",
            "tool": {"toolInvocationId": "search", "status": "completed", "output": {"results": []}}
        }
    }))
    .unwrap();
    assert_eq!(snapshot.status, "completed");
    assert_eq!(snapshot.result.unwrap()["results"], serde_json::json!([]));
    let part: sprocket_transcript::TranscriptPart = snapshot.part.unwrap().into();
    assert_eq!(part.number, 3);
    assert_eq!(
        part.tool.unwrap().tool_invocation_id.as_deref(),
        Some("search")
    );

    for part in [None, Some(serde_json::Value::Null)] {
        let mut value = serde_json::json!({"status": "running"});
        if let Some(part) = part {
            value["part"] = part;
        }
        let snapshot: ExecutorJobSnapshot = serde_json::from_value(value).unwrap();
        assert!(snapshot.part.is_none());
    }
}
