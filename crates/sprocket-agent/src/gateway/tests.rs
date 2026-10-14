use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::StreamExt;
use rig::completion::CompletionRequest;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::timeout;

use super::*;

const TEST_TIMEOUT: Duration = Duration::from_secs(10);

fn request() -> CompletionRequest {
    CompletionRequest::new(crate::openai::developer_message("Continue the task."))
        .messages([rig::completion::Message::user("hello")])
}

#[tokio::test]
async fn completion_and_stream_use_the_refreshed_credential() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut captured = Vec::new();
        for index in 0..3 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                bytes.push(byte[0]);
            }
            let headers = String::from_utf8(bytes).unwrap();
            let content_length: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|length| length.trim().parse().unwrap())
                })
                .unwrap();
            let mut body = vec![0; content_length];
            socket.read_exact(&mut body).await.unwrap();
            let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(request["instructions"], "Base instructions.");
            assert_eq!(request["input"][0]["role"], "user");
            assert_eq!(request["input"][1]["role"], "developer");
            assert_eq!(
                request["input"][1]["content"][0]["text"],
                "Continue the task."
            );
            assert!(request.get("store").is_none());
            let response = json!({
                "id": "response-test",
                "object": "response",
                "created_at": 0,
                "status": "completed",
                "model": "test-model",
                "output": [{
                    "type": "message",
                    "id": "message-test",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{"type": "output_text", "text": "hello", "annotations": []}]
                }],
                "tools": [],
                "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
            });
            let (content_type, body) = match index {
                0 | 1 => ("application/json", response.to_string()),
                _ => (
                    "text/event-stream",
                    format!(
                        "data: {}\n\n",
                        json!({
                            "type": "response.completed",
                            "sequence_number": 0,
                            "response": response
                        })
                    ),
                ),
            };
            captured.push(headers);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
        captured
    });
    let issued = Arc::new(AtomicUsize::new(0));
    let client = GatewayClient::new(base_url, {
        let issued = issued.clone();
        move || {
            let number = issued.fetch_add(1, Ordering::SeqCst) + 1;
            async move {
                Ok::<_, anyhow::Error>(GatewayCredential {
                    token: format!("token-{number}"),
                    expires_at: now_ms() + 36 * 60 * 60 * 1000,
                })
            }
        }
    });
    let model = client.completion_model("test-model", "Base instructions.");
    timeout(TEST_TIMEOUT, model.call(request()))
        .await
        .unwrap()
        .unwrap();
    timeout(TEST_TIMEOUT, model.call(request()))
        .await
        .unwrap()
        .unwrap();
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(36 * 60 * 60)).await;
    tokio::time::resume();
    timeout(TEST_TIMEOUT, async {
        let mut stream = model.stream(request()).unwrap();
        while let Some(item) = stream.next().await {
            item.unwrap();
        }
    })
    .await
    .unwrap();
    let headers = timeout(TEST_TIMEOUT, server).await.unwrap().unwrap();
    assert_eq!(headers.len(), 3);
    assert!(
        headers[0]
            .to_ascii_lowercase()
            .contains("authorization: bearer token-1")
    );
    assert!(
        headers[1]
            .to_ascii_lowercase()
            .contains("authorization: bearer token-1")
    );
    assert!(
        headers[2]
            .to_ascii_lowercase()
            .contains("authorization: bearer token-2")
    );
    assert_eq!(issued.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn concurrent_requests_reuse_the_cache_and_refresh_before_expiry() {
    let issued = Arc::new(AtomicUsize::new(0));
    let auth = GatewayAuth::new({
        let issued = issued.clone();
        move || {
            let issued = issued.clone();
            async move {
                tokio::task::yield_now().await;
                issued.fetch_add(1, Ordering::SeqCst);
                Ok(GatewayCredential {
                    token: "test".into(),
                    expires_at: now_ms() + 36 * 60 * 60 * 1000,
                })
            }
        }
    });
    let cloned = auth.clone();
    let (a, b) = tokio::join!(auth.resolve_credential(), cloned.resolve_credential());
    a.unwrap();
    b.unwrap();
    assert_eq!(issued.load(Ordering::SeqCst), 1);
    let refresh_at = auth.cached.lock().await.as_ref().unwrap().refresh_at;
    tokio::time::advance(refresh_at.duration_since(Instant::now()) - Duration::from_millis(1))
        .await;
    auth.resolve_credential().await.unwrap();
    assert_eq!(issued.load(Ordering::SeqCst), 1);
    tokio::time::advance(Duration::from_millis(1)).await;
    let cloned = auth.clone();
    let (a, b) = tokio::join!(auth.resolve_credential(), cloned.resolve_credential());
    a.unwrap();
    b.unwrap();
    assert_eq!(issued.load(Ordering::SeqCst), 2);
    tokio::time::advance(Duration::from_secs(37 * 60 * 60)).await;
    auth.resolve_credential().await.unwrap();
    assert_eq!(issued.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn failed_refresh_can_retry_without_using_the_stale_credential() {
    let issued = Arc::new(AtomicUsize::new(0));
    let auth = GatewayAuth::new({
        let issued = issued.clone();
        move || {
            let attempt = issued.fetch_add(1, Ordering::SeqCst);
            async move {
                if attempt == 1 {
                    anyhow::bail!("credential service unavailable");
                }
                Ok(GatewayCredential {
                    token: "test".into(),
                    expires_at: now_ms() + 3_600_000,
                })
            }
        }
    });
    auth.resolve_credential().await.unwrap();
    auth.cached.lock().await.as_mut().unwrap().refresh_at = Instant::now();
    assert!(auth.resolve_credential().await.is_err());
    auth.resolve_credential().await.unwrap();
    assert_eq!(issued.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn credentials_within_the_refresh_headroom_are_rejected() {
    let issued = Arc::new(AtomicUsize::new(0));
    let auth = GatewayAuth::new({
        let issued = issued.clone();
        move || {
            let issued = issued.clone();
            async move {
                let expires_at = match issued.fetch_add(1, Ordering::SeqCst) {
                    0 => now_ms() - 1,
                    _ => now_ms() + REFRESH_HEADROOM_MS - 1,
                };
                Ok(GatewayCredential {
                    token: "test".into(),
                    expires_at,
                })
            }
        }
    });
    for _ in 0..2 {
        let error = auth.resolve_credential().await.err().unwrap();
        assert!(error.to_string().contains("too close to expiry"));
    }
    assert_eq!(issued.load(Ordering::SeqCst), 2);
    assert!(auth.cached.lock().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn wall_clock_expired_cache_entry_is_not_reused() {
    let issued = Arc::new(AtomicUsize::new(0));
    let auth = GatewayAuth::new({
        let issued = issued.clone();
        move || {
            let issued = issued.clone();
            async move {
                issued.fetch_add(1, Ordering::SeqCst);
                Ok(GatewayCredential {
                    token: "test".into(),
                    expires_at: now_ms() + 3_600_000,
                })
            }
        }
    });
    auth.resolve_credential().await.unwrap();
    // A wall-clock jump past expiry must force a refresh even though the
    // monotonic refresh deadline is still far ahead.
    auth.cached.lock().await.as_mut().unwrap().expires_at = now_ms() - 1;
    auth.resolve_credential().await.unwrap();
    assert_eq!(issued.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn credential_failures_reach_both_inference_paths() {
    let client = GatewayClient::new("http://127.0.0.1:1/v1".to_string(), || async {
        Err::<GatewayCredential, _>(anyhow::anyhow!("Run is no longer active."))
    });
    let model = client.completion_model("test-model", "Base instructions.");
    let error = model.call(request()).await.unwrap_err();
    assert!(error.to_string().contains("Run is no longer active."));
    let mut stream = model.stream(request()).unwrap();
    match stream.next().await {
        Some(Err(error)) => assert!(error.to_string().contains("Run is no longer active.")),
        other => panic!("a cancelled claim cannot start inference: {other:?}"),
    }
}
