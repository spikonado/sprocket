use super::*;

#[test]
fn completion_response_decodes_the_authoritative_persisted_part() {
    let value = Value::try_from(serde_json::json!({
        "_creationTime": 1_700_000_000_000.5,
        "number": 8,
        "sourceKey": "completion:run:stream",
        "kind": "completion",
        "runId": "run",
        "work": {
            "ranges": [{ "start": 0, "end": 2, "sectionKey": "section-1" }]
        },
        "completion": {
            "streamId": "stream",
            "items": [{ "type": "reasoning", "text": "thinking" }]
        }
    }))
    .unwrap();
    let part: Option<PersistedTranscriptPart> =
        decode_function_result(FunctionResult::Value(value), "finalizeCompletionCall").unwrap();
    let part: sprocket_transcript::TranscriptPart = part.unwrap().into();
    assert_eq!(part.number, 8);
    assert_eq!(part.created_at, Some(1_700_000_000_000));
    let work = part.work_assignment();
    assert_eq!(work.ranges[0].section_key, "section-1");
    assert_eq!(work.ranges[0].end, 2);
    assert_eq!(
        part.completion.unwrap().stream_id.as_deref(),
        Some("stream")
    );

    let empty: Option<PersistedTranscriptPart> =
        decode_function_result(FunctionResult::Value(Value::Null), "finalizeCompletionCall")
            .unwrap();
    assert!(empty.is_none());
}
