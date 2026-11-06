use super::*;

#[test]
fn transcript_state_reads_files_that_list_downloaded_ranges() {
    let state: TranscriptState = serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "userId": "user",
        "threadId": "thread",
        "remoteTotalParts": 3,
        "historyFromNumber": 0,
        "downloadedRanges": [{ "start": 0, "end": 2 }],
        "stale": false
    }))
    .unwrap();
    assert_eq!(state.remote_total_parts, 3);
}

#[test]
fn transcript_part_keeps_old_json_without_created_at() {
    let part: TranscriptPart = serde_json::from_value(serde_json::json!({
        "number": 3,
        "sourceKey": "prompt:3",
        "kind": "prompt",
        "runId": "run",
        "prompt": { "text": "hi", "imageUploads": [] }
    }))
    .unwrap();
    assert_eq!(part.number, 3);
    assert_eq!(part.created_at, None);
    assert_eq!(
        part.prompt.as_ref().map(|prompt| prompt.text.as_str()),
        Some("hi")
    );
}
