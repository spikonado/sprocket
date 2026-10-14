use super::*;

#[test]
fn parses_embedded_work_without_exposing_metadata_as_completion_content() {
    let parts = parse_remote_parts(serde_json::json!({
        "parts": [{
            "number": 2,
            "sourceKey": "completion:run:stream",
            "kind": "completion",
            "runId": "run",
            "work": {
                "ranges": [{ "start": 0, "end": 1, "sectionKey": "section" }]
            },
            "completion": {
                "streamId": "stream",
                "items": [{ "type": "reasoning", "text": "thinking" }]
            }
        }]
    }))
    .unwrap();
    assert_eq!(parts[0].work_assignment().ranges[0].section_key, "section");
    assert_eq!(parts[0].content_items().len(), 1);
}

#[test]
fn attachment_wire_formats_serialize_with_storage_identity_only() {
    for legacy in [false, true] {
        let mut attachment = serde_json::json!({
            "storageId": "storage", "name": "file.txt",
            "mediaType": "text/plain", "size": 4.0
        });
        if legacy {
            attachment["imageUploadId"] = "upload".into();
        }
        let parts = parse_remote_parts(serde_json::json!({"parts": [{
            "number": 0.0, "sourceKey": "prompt:0", "kind": "prompt", "runId": "run",
            "prompt": {"text": "hi", "imageUploads": [attachment]}
        }]}))
        .unwrap();
        let meta = &parts[0].prompt.as_ref().unwrap().image_uploads[0];
        assert_eq!(meta.storage_id, "storage");
        let json = serde_json::to_value(meta).unwrap();
        assert!(json.get("imageUploadId").is_none());
        let mut old_local = json.clone();
        old_local["imageUploadId"] = "upload".into();
        assert_eq!(
            serde_json::from_value::<TranscriptAttachmentMeta>(old_local).unwrap(),
            *meta
        );
    }
}

#[test]
fn remote_parts_read_convex_creation_time() {
    let parts = parse_remote_parts(serde_json::json!({
        "parts": [{
            "number": 2.0,
            "sourceKey": "tool:inv:started",
            "kind": "tool",
            "runId": "run",
            "_creationTime": 1_700_000_000_000.125,
            "tool": {
                "callId": "c1",
                "name": "exec_command",
                "status": "started"
            }
        }]
    }))
    .unwrap();
    assert_eq!(parts[0].created_at, Some(1_700_000_000_000));
    assert_eq!(parts[0].tool.as_ref().unwrap().call_id, "c1");
    assert_eq!(parts[0].tool.as_ref().unwrap().input, None);
}

#[tokio::test]
async fn remote_command_inputs_survive_local_storage() {
    let inputs = [
        serde_json::json!({"sessionId":"session"}),
        serde_json::json!({"sessionId":"session","action":"write"}),
    ];
    let parts = parse_remote_parts(serde_json::json!({
        "parts": [
            {
                "number": 0.0,
                "sourceKey": "tool:poll:started",
                "kind": "tool",
                "runId": "run",
                "tool": {
                    "callId": "poll",
                    "name": "poll_cmd",
                    "input": inputs[0],
                    "status": "started"
                }
            },
            {
                "number": 1.0,
                "sourceKey": "tool:control:failed",
                "kind": "tool",
                "runId": "run",
                "tool": {
                    "callId": "control",
                    "name": "control_cmd",
                    "input": inputs[1],
                    "output": {"error":"session unavailable"},
                    "status": "failed"
                }
            }
        ]
    }))
    .unwrap();
    for (part, input) in parts.iter().zip(&inputs) {
        assert_eq!(part.tool.as_ref().unwrap().input.as_ref(), Some(input));
    }

    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    store.append_parts("user", "thread", &parts).await.unwrap();
    let stored = store.read_parts("user", "thread", &[0, 1]).await.unwrap();
    assert_eq!(stored, parts);
}

#[test]
fn remote_parts_keep_working_without_creation_time() {
    let parts = parse_remote_parts(serde_json::json!({
        "parts": [{
            "number": 0.0,
            "sourceKey": "prompt:0",
            "kind": "prompt",
            "runId": "run",
            "prompt": { "text": "hi", "imageUploads": [] }
        }]
    }))
    .unwrap();
    assert_eq!(parts[0].created_at, None);
    assert_eq!(parts[0].prompt.as_ref().unwrap().text, "hi");
}
