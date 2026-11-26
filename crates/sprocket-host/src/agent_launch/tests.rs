use super::*;

fn request(json: serde_json::Value) -> AgentLaunchRequest {
    serde_json::from_value(json).expect("valid agent request")
}

fn base_request() -> serde_json::Value {
    serde_json::json!({
        "userId": "user-1",
        "submissionId": "submission-1",
        "prompt": "Build it",
        "fileIds": [],
        "selectedModel": "gpt-5.6-sol",
        "reasoningEffort": "medium",
        "fastMode": false,
        "workspacePath": "/workspace"
    })
}

#[test]
fn reads_recovery_requests_saved_with_storage_ids() {
    let mut json = base_request();
    json.as_object_mut().unwrap().remove("fileIds");
    json["storageIds"] = serde_json::json!([]);
    assert!(request(json).file_ids.is_empty());
}

#[test]
fn defaults_older_requests_to_spikonado() {
    assert_eq!(
        request(base_request()).completion_provider,
        CompletionProvider::Spikonado
    );
}

#[test]
fn requires_fast_mode() {
    let mut json = base_request();
    json.as_object_mut().unwrap().remove("fastMode");
    json["serviceTier"] = "fast".into();
    assert!(serde_json::from_value::<AgentLaunchRequest>(json).is_err());
}
