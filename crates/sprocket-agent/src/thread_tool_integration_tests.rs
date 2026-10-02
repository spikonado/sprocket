use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use futures::{SinkExt, StreamExt};
use rig::tool::{Tool, ToolContext, ToolErrorKind};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use super::{OrderedContent, ToolCallTracker};
use crate::convex::RuntimeClient;
use crate::tools::agent_tools;
use crate::types::RunAgentRequest;

async fn invoke_thread_tool(thread_id: &str, finished: bool, accepted: bool) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let deployment = format!("http://{}", listener.local_addr().unwrap());
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let server =
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut version =
                json!({ "querySet": 0, "identity": 0, "ts": STANDARD.encode(0_u64.to_le_bytes()) });
            let mut timestamp = 0_u64;
            let mut mutations = Vec::new();
            while let Some(message) = socket.next().await {
                let Message::Text(text) = message.unwrap() else {
                    continue;
                };
                let message: Value = serde_json::from_str(&text).unwrap();
                let mut end_version = version.clone();
                let modifications =
                    match message["type"].as_str().unwrap() {
                        "Authenticate" => {
                            end_version["identity"] =
                                json!(message["baseVersion"].as_u64().unwrap() + 1);
                            vec![]
                        }
                        "ModifyQuerySet" => {
                            let query = &message["modifications"][0];
                            assert_eq!(query["type"], "Add");
                            assert_eq!(query["udfPath"], "agentRuntime:isFinished");
                            assert_eq!(query["args"][0]["runId"], "run-id");
                            assert_eq!(query["args"][0]["executionSecret"], "execution-secret");
                            end_version["querySet"] = message["newVersion"].clone();
                            vec![json!({
                                "type": "QueryUpdated", "queryId": query["queryId"],
                                "value": finished, "logLines": [], "journal": null
                            })]
                        }
                        "Mutation" => {
                            let result = match mutations.len() {
                                0 => {
                                    assert_eq!(message["udfPath"], "agentRuntime:beginToolJob");
                                    json!({ "jobId": "executor-job-id" })
                                }
                                1 => {
                                    assert_eq!(message["udfPath"], "executor:complete");
                                    json!(accepted)
                                }
                                _ => panic!("unexpected mutation: {message}"),
                            };
                            socket.send(Message::Text(json!({
                        "type": "MutationResponse", "requestId": message["requestId"],
                        "success": true, "result": result, "logLines": [],
                        "ts": STANDARD.encode((timestamp + 1).to_le_bytes())
                    }).to_string().into())).await.unwrap();
                            mutations.push(message["args"][0].clone());
                            vec![]
                        }
                        "Connect" => continue,
                        other => panic!("unexpected client message: {other}"),
                    };
                timestamp += 1;
                end_version["ts"] = json!(STANDARD.encode(timestamp.to_le_bytes()));
                socket
                    .send(Message::Text(
                        json!({
                            "type": "Transition", "startVersion": version,
                            "endVersion": end_version, "modifications": modifications
                        })
                        .to_string()
                        .into(),
                    ))
                    .await
                    .unwrap();
                version = end_version;
                if mutations.len() == 2 || (finished && version["querySet"] == 1) {
                    let _ = done_rx.await;
                    return mutations;
                }
            }
            panic!("connection closed before the tool finished");
        });

    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().to_path_buf();
    let request = RunAgentRequest {
        deployment_url: deployment.clone(),
        auth_token_fetcher: Arc::new(|_| {
            Box::pin(async {
                Ok(format!(
                    "e30.{}.signature",
                    URL_SAFE_NO_PAD.encode(r#"{"exp":4102444800}"#)
                ))
            })
        }),
        execution_secret: "execution-secret".into(),
        thread_id: thread_id.into(),
        submission_id: "submission-id".into(),
        chatgpt_credentials: None,
        allow_interaction: false,
        cancellation: Default::default(),
        repository_key: None,
        prompt: String::new(),
        storage_ids: vec![],
        selected_model: "test-model".into(),
        completion_provider: Default::default(),
        reasoning_effort: "none".into(),
        fast_mode: false,
        workspace_path: workspace.to_string_lossy().into_owned(),
        installation_id: "installation-id".into(),
        continuation_of_run_id: None,
    };
    let runtime = RuntimeClient::from_request(&request).await.unwrap();
    let tracker = ToolCallTracker::new("run-id", "claim-id");
    tracker.observe_streamed_call("model-call-id", "internal-call-id");
    tracker.record_turn(&[OrderedContent::Tool {
        model_call_id: "model-call-id".into(),
        call_id: "call-id".into(),
    }]);
    tracker.prepare_dispatch("get_thread_id", "internal-call-id", Some("call-id"), "{}");
    let assignment = tracker.completion_assignments().tool_invocations[0].clone();
    let tools = agent_tools(
        runtime,
        "run-id".into(),
        "claim-id".into(),
        workspace.clone(),
        workspace.clone(),
        crate::artifact_bindings::ArtifactBindings::new(
            &workspace,
            &deployment,
            "user-id",
            &workspace,
        ),
        thread_id.into(),
        false,
        tracker,
        Arc::from([]),
    );
    let result = tools
        .get_thread_id
        .call(
            &mut ToolContext::new(),
            serde_json::from_value(json!({})).unwrap(),
        )
        .await;
    let _ = done_tx.send(());
    let mutations = server.await.unwrap();
    if finished {
        assert!(mutations.is_empty());
    } else {
        let begin = &mutations[0];
        assert_eq!(begin["kind"], "get_thread_id");
        assert_eq!(begin["payload"], json!({}));
        assert_eq!(begin["callId"], "call-id");
        assert_eq!(begin["toolInvocationId"], assignment.tool_invocation_id);
        assert_eq!(begin["sectionKey"], assignment.section_key);
        let complete = &mutations[1];
        assert_eq!(complete["jobId"], "executor-job-id");
        assert_eq!(complete["result"], json!({ "threadId": thread_id }));
        for mutation in &mutations {
            assert_eq!(mutation["runId"], "run-id");
            assert_eq!(mutation["claimId"], "claim-id");
            assert_eq!(mutation["executionSecret"], "execution-secret");
        }
    }
    if finished || !accepted {
        assert_eq!(result.unwrap_err().kind(), ToolErrorKind::Cancelled);
    } else {
        assert_eq!(result.unwrap(), json!({ "threadId": thread_id }));
    }
}

#[tokio::test]
async fn thread_tool_returns_its_context_id_and_submits_the_durable_result() {
    for thread_id in ["first-thread-id", "second-thread-id"] {
        tokio::time::timeout(
            Duration::from_secs(10),
            invoke_thread_tool(thread_id, false, true),
        )
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn thread_tool_observes_cancellation_and_rejected_completion() {
    for (finished, accepted) in [(true, true), (false, false)] {
        tokio::time::timeout(
            Duration::from_secs(10),
            invoke_thread_tool("thread-id", finished, accepted),
        )
        .await
        .unwrap();
    }
}
