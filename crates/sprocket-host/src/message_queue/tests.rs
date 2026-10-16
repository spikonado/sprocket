use super::*;

#[test]
fn launches_saved_continuations_without_consuming_follow_up_attachments() {
    let message: ClaimedMessage = serde_json::from_value(serde_json::json!({
        "_id": "queue-a", "userId": "user-a", "threadId": "thread-a",
        "submissionId": "follow-up", "executionSecret": "follow-up-secret",
        "prompt": "Build it", "storageIds": ["file-a"], "selectedModel": "new-model",
        "completionProvider": "openai", "reasoningEffort": "high", "fastMode": true,
        "workspacePath": "/project",
        "continuation": {
            "submissionId": "saved-answer", "executionSecret": "saved-answer-secret",
            "continuationOfRunId": "parent-run", "prompt": "Board A",
            "selectedModel": "parent-model", "completionProvider": "chatgpt",
            "reasoningEffort": "medium", "fastMode": false
        }
    }))
    .unwrap();
    let (id, request) = message.into_launch();
    assert_eq!(id, "queue-a");
    assert_eq!(request.submission_id, "saved-answer");
    assert_eq!(
        request.execution_secret.as_deref(),
        Some("saved-answer-secret")
    );
    assert_eq!(
        request.continuation_of_run_id.as_deref(),
        Some("parent-run")
    );
    assert_eq!(request.prompt, "Board A");
    assert!(request.storage_ids.is_empty());
    assert_eq!(request.selected_model, "parent-model");
    assert_eq!(
        request.completion_provider,
        sprocket_agent::CompletionProvider::Chatgpt
    );
    assert_eq!(request.reasoning_effort, "medium");
    assert!(!request.fast_mode);
    assert_eq!(request.workspace_path, "/project");
}

#[test]
fn decodes_queue_bookkeeping_without_relaxing_the_http_decoder() {
    let message: ClaimedMessage = serde_json::from_value(serde_json::json!({
        "_id": "queue-a", "_creationTime": 1.0, "machineId": "machine-a",
        "claimId": "worker-a", "status": "sending", "attachmentNames": ["board.png"],
        "userId": "user-a", "submissionId": "submission-a", "executionSecret": "secret-a",
        "threadId": "thread-a", "prompt": "Build it", "storageIds": ["file-a"],
        "selectedModel": "model-a", "completionProvider": "openai",
        "reasoningEffort": "high", "fastMode": true, "workspacePath": "/project"
    }))
    .unwrap();
    let (_, request) = message.into_launch();
    assert_eq!(request.execution_secret.as_deref(), Some("secret-a"));
    assert_eq!(request.thread_id.as_deref(), Some("thread-a"));
    assert_eq!(request.storage_ids, vec!["file-a"]);
    assert_eq!(
        request.completion_provider,
        sprocket_agent::CompletionProvider::Openai
    );
    assert!(request.fast_mode);
    let args = enqueue_args(request, "machine-a".into(), "credential-a".into()).unwrap();
    assert_eq!(
        args.get("completionProvider"),
        Some(&Value::String("openai".into()))
    );
}
