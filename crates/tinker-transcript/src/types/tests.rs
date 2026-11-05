use super::*;

#[test]
fn merges_adjacent_downloaded_ranges() {
    let mut state = TranscriptState::new("user".into(), "thread".into());
    state.mark_downloaded(&[0, 2, 1, 5, 4]);
    assert_eq!(
        state.downloaded_ranges,
        vec![
            DownloadedRange { start: 0, end: 2 },
            DownloadedRange { start: 4, end: 5 }
        ]
    );
    assert_eq!(state.missing_in(0, 7), vec![3, 6]);
    state.remote_total_parts = 1;
    assert_eq!(state.visible_end_exclusive(), 6);
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
