use super::*;

fn decode<T: DeserializeOwned>(value: serde_json::Value) -> T {
    decode_function_result(
        FunctionResult::Value(Value::try_from(value).unwrap()),
        "transcript mutation",
    )
    .unwrap()
}

#[tokio::test]
async fn caches_returned_prompts_completions_and_tool_results_idempotently() {
    let directory = tempfile::tempdir().unwrap();
    let store = sprocket_transcript::TranscriptStore::new(directory.path().to_owned());
    let output = crate::RunOutput::default();
    output.initialize(store.clone(), "user".into(), "thread".into(), "run".into());
    let begin = serde_json::json!({
        "accepted": true,
        "parts": [
            {"number": 0, "sourceKey": "hidden:instructions", "kind": "prompt", "runId": "run",
             "prompt": {"text": "instructions", "hidden": "instructions", "imageUploads": []}},
            {"number": 1, "sourceKey": "hidden:environment", "kind": "prompt", "runId": "run",
             "prompt": {"text": "environment", "hidden": "environment", "imageUploads": []}},
            {"number": 2, "sourceKey": "prompt:run", "kind": "prompt", "runId": "run",
             "prompt": {"text": "hello", "imageUploads": [{
                 "name": "photo.png", "mediaType": "image/png", "size": 12,
                 "fileId": "file", "storageId": "file"
             }]}}
        ]
    });
    let completion = serde_json::json!({
        "_creationTime": 1_700_000_000_000.5,
        "number": 3, "sourceKey": "completion:run:stream", "kind": "completion", "runId": "run",
        "completion": {"items": [{
            "type": "tool-call", "callId": "call", "toolInvocationId": "inv",
            "name": "apply_patch", "input": {"patch": "patch"}
        }]}
    });
    let finalized = serde_json::json!({
        "completion": completion,
        "parts": [completion, {
            "number": 4, "sourceKey": "tool:inv:finished", "kind": "tool", "runId": "run",
            "tool": {"callId": "call", "name": "apply_patch", "toolInvocationId": "inv",
                     "status": "completed", "output": {"changes": [{"path": "hello.txt", "operation": "created"}]}}
        }]
    });
    let reply = serde_json::json!({
        "number": 5, "sourceKey": "completion:run:reply", "kind": "completion", "runId": "run",
        "completion": {"items": [{"type": "text", "text": "Created hello.txt."}]}
    });
    for _ in 0..2 {
        let begin: PartsMutationResponse = decode(begin.clone());
        assert!(begin.accepted);
        let finalized: CompletionMutationResponse = decode(finalized.clone());
        let reply: CompletionMutationResponse = decode(serde_json::json!({
            "completion": reply, "parts": [reply]
        }));
        for parts in [begin.parts, finalized.parts, reply.parts] {
            let parts: Vec<_> = parts.into_iter().map(TranscriptPart::from).collect();
            output.record_parts(&parts).await;
        }
    }
    let page = output.page(-1).await.unwrap();
    assert_eq!(
        page.parts
            .iter()
            .map(|part| part.number)
            .collect::<Vec<_>>(),
        (0..6).collect::<Vec<_>>()
    );
    let cached = store
        .read_parts("user", "thread", &[0, 1, 2, 3, 4, 5])
        .await
        .unwrap();
    assert_eq!(cached.len(), 6);
    assert_eq!(cached[0].prompt.as_ref().unwrap().text, "instructions");
    assert_eq!(cached[1].prompt.as_ref().unwrap().text, "environment");
    let attachment = &cached[2].prompt.as_ref().unwrap().image_uploads[0];
    assert_eq!(attachment.size, 12);
    assert_eq!(attachment.file_id.as_deref(), Some("file"));
    assert_eq!(cached[3].created_at, Some(1_700_000_000_000));
    assert_eq!(
        cached[3].completion.as_ref().unwrap().items[0]["toolInvocationId"],
        "inv"
    );
    assert_eq!(
        cached[4].tool.as_ref().unwrap().output.as_ref().unwrap()["changes"][0]["path"],
        "hello.txt"
    );
    assert_eq!(
        cached[5].completion.as_ref().unwrap().items[0]["text"],
        "Created hello.txt."
    );
}

#[test]
fn persisted_parts_still_decode_legacy_work_and_tool_fields() {
    let part: PersistedTranscriptPart = serde_json::from_value(serde_json::json!({
        "number": 1, "sourceKey": "legacy", "kind": "tool", "runId": "run",
        "work": {"sectionKey": "section-1"},
        "tool": {"toolInvocationId": "inv", "callId": "call", "name": "exec_cmd",
                 "input": {"cmd": "pwd"}, "status": "started"}
    }))
    .unwrap();
    let part: TranscriptPart = part.into();
    let tool = part.tool.unwrap();
    assert_eq!(tool.name, "exec_cmd");
    assert_eq!(tool.call_id, "call");
}
