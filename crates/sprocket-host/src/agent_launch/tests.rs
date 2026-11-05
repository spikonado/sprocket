use super::*;

fn request(json: serde_json::Value) -> AgentLaunchRequest {
    serde_json::from_value(json).expect("valid agent request")
}

fn base_request() -> serde_json::Value {
    serde_json::json!({
        "userId": "user-1",
        "submissionId": "submission-1",
        "prompt": "Build it",
        "storageIds": [],
        "selectedModel": "gpt-5.6-sol",
        "reasoningEffort": "medium",
        "fastMode": false,
        "workspacePath": "/workspace"
    })
}

#[test]
fn accepts_fast_mode_requests() {
    let mut json = base_request();
    json["fastMode"] = true.into();
    assert!(request(json).fast_mode);
}

#[test]
fn defaults_older_requests_to_spikonado() {
    assert_eq!(
        request(base_request()).completion_provider,
        CompletionProvider::Spikonado
    );
}

#[test]
fn accepts_direct_openai_requests() {
    let mut json = base_request();
    json["completionProvider"] = "openai".into();
    assert_eq!(
        request(json).completion_provider,
        CompletionProvider::Openai
    );
}

#[test]
fn accepts_chatgpt_subscription_requests() {
    let mut json = base_request();
    json["completionProvider"] = "chatgpt".into();
    assert_eq!(
        request(json).completion_provider,
        CompletionProvider::Chatgpt
    );
}

#[test]
fn requires_fast_mode() {
    let mut json = base_request();
    json.as_object_mut().unwrap().remove("fastMode");
    json["serviceTier"] = "fast".into();
    assert!(serde_json::from_value::<AgentLaunchRequest>(json).is_err());
}

#[test]
fn exhausted_usage_fails_the_launch_with_the_plain_limit_message() {
    let data = [
        ("code", "USAGE_LIMIT_REACHED"),
        ("message", "Usage limit reached. Try again in 3h 20m."),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_string(), value.into()))
    .collect();
    let error = sprocket_convex::decode_function_result::<()>(
        convex::FunctionResult::ConvexError(convex::ConvexError {
            message: String::new(),
            data: convex::Value::Object(data),
        }),
        "agentRuntime:issueGatewayCredential",
    )
    .unwrap_err();
    let failure = start_failure(&error);
    assert!(matches!(failure, LaunchError::UsageLimitReached(_)));
    assert_eq!(
        failure.to_string(),
        "Usage limit reached. Try again in 3h 20m."
    );
    assert_eq!(
        start_failure(&anyhow!("boom")).to_string(),
        "failed to start agent run: boom"
    );
}
