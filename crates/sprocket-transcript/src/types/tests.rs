use super::*;

#[test]
fn old_invocation_mapping_normalizes_call_items_without_replacing_canonical_ids() {
    let part: TranscriptPart = serde_json::from_value(serde_json::json!({
        "number": 0, "sourceKey": "completion:run:0", "kind": "completion", "runId": "run",
        "completion": {"items": [
            {"type":"tool-call", "callId":"reused"},
            {"type":"tool-call", "callId":"reused", "toolInvocationId":"canonical"}
        ]},
        "work": {"toolInvocations": [
            {"item":0, "toolInvocationId":"legacy"},
            {"item":1, "toolInvocationId":"obsolete"}
        ]}
    }))
    .unwrap();
    assert_eq!(part.content_items()[0]["toolInvocationId"], "legacy");
    assert_eq!(part.content_items()[1]["toolInvocationId"], "canonical");
    let stored = serde_json::to_value(&part).unwrap();
    assert_eq!(
        serde_json::from_value::<TranscriptPart>(stored).unwrap(),
        part
    );
}
