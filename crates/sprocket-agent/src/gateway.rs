use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use rig::client::CompletionClient;
use rig::completion::{
    CompletionError, CompletionModel, CompletionRequest, CompletionResponse, ProviderCapabilities,
};
use rig::providers::openai;
use rig::streaming::StreamingCompletionResponse;
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::live::now_ms;
use crate::types::GatewayCredential;

const REFRESH_HEADROOM_MS: u64 = 60_000;

struct CachedClient {
    client: openai::Client,
    expires_at: u64,
    refresh_at: Instant,
}

#[derive(Clone)]
pub(crate) struct GatewayClient<F> {
    base_url: String,
    issue_credential: F,
    http: reqwest::Client,
    cached: Arc<Mutex<Option<CachedClient>>>,
}

impl<F> GatewayClient<F> {
    pub(crate) fn new(base_url: String, issue_credential: F) -> Self {
        Self {
            base_url,
            issue_credential,
            http: reqwest::Client::new(),
            cached: Arc::default(),
        }
    }
}

impl<F, Fut> CompletionClient for GatewayClient<F>
where
    F: Fn() -> Fut + Clone + Send + Sync + 'static,
    Fut: Future<Output = anyhow::Result<GatewayCredential>> + Send,
{
    type CompletionModel = GatewayModel<F>;

    fn completion_model(&self, model: impl Into<String>) -> Self::CompletionModel {
        GatewayModel {
            client: self.clone(),
            model: model.into(),
        }
    }
}

pub(crate) struct GatewayModel<F> {
    client: GatewayClient<F>,
    model: String,
}

impl<F, Fut> GatewayModel<F>
where
    F: Fn() -> Fut,
    Fut: Future<Output = anyhow::Result<GatewayCredential>>,
{
    async fn responses_model(
        &self,
    ) -> Result<openai::responses_api::ResponsesCompletionModel, CompletionError> {
        let mut cached = self.client.cached.lock().await;
        if let Some(cached) = cached.as_ref()
            && Instant::now() < cached.refresh_at
            && cached.expires_at.saturating_sub(now_ms()) > REFRESH_HEADROOM_MS
        {
            return Ok(cached.client.completion_model(&self.model));
        }
        let credential = (self.client.issue_credential)()
            .await
            .map_err(|error| CompletionError::RequestError(error.into_boxed_dyn_error()))?;
        let remaining_ms = credential.expires_at.saturating_sub(now_ms());
        if remaining_ms <= REFRESH_HEADROOM_MS {
            return Err(CompletionError::RequestError(
                "Gateway returned a credential too close to expiry.".into(),
            ));
        }
        let client = openai::Client::builder()
            .api_key(credential.token)
            .base_url(&self.client.base_url)
            .http_client(self.client.http.clone())
            .build()
            .map_err(|error| CompletionError::RequestError(error.into()))?;
        let model = client.completion_model(&self.model);
        *cached = Some(CachedClient {
            client,
            expires_at: credential.expires_at,
            refresh_at: Instant::now() + Duration::from_millis(remaining_ms - REFRESH_HEADROOM_MS),
        });
        Ok(model)
    }
}

impl<F, Fut> CompletionModel for GatewayModel<F>
where
    F: Fn() -> Fut + Send + Sync,
    Fut: Future<Output = anyhow::Result<GatewayCredential>> + Send,
{
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities::default().with_native_output_tool_composition(true)
    }

    async fn completion(
        &self,
        request: CompletionRequest,
    ) -> Result<CompletionResponse, CompletionError> {
        self.responses_model().await?.completion(request).await
    }

    async fn stream(
        &self,
        request: CompletionRequest,
    ) -> Result<StreamingCompletionResponse, CompletionError> {
        self.responses_model().await?.stream(request).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use futures::StreamExt;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::time::timeout;

    use super::*;

    const TEST_TIMEOUT: Duration = Duration::from_secs(10);

    fn request() -> CompletionRequest {
        CompletionRequest {
            model: None,
            preamble: None,
            chat_history: vec![rig::completion::Message::user("hello")],
            documents: vec![],
            tools: vec![],
            temperature: None,
            max_tokens: None,
            tool_choice: None,
            additional_params: None,
            output_schema: None,
            record_telemetry_content: false,
        }
    }

    #[tokio::test]
    async fn completion_and_stream_use_the_refreshed_credential() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(timeout(TEST_TIMEOUT, async move {
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
        }));
        let issued = Arc::new(AtomicUsize::new(0));
        let client = GatewayClient::new(base_url, {
            let issued = issued.clone();
            move || {
                let number = issued.fetch_add(1, Ordering::SeqCst) + 1;
                async move {
                    Ok(GatewayCredential {
                        token: format!("token-{number}"),
                        expires_at: now_ms() + 36 * 60 * 60 * 1000,
                    })
                }
            }
        });
        let model = client.completion_model("test-model");
        timeout(TEST_TIMEOUT, model.completion(request()))
            .await
            .unwrap()
            .unwrap();
        timeout(TEST_TIMEOUT, model.completion(request()))
            .await
            .unwrap()
            .unwrap();
        client.cached.lock().await.as_mut().unwrap().refresh_at = Instant::now();
        timeout(TEST_TIMEOUT, async {
            let mut stream = model.stream(request()).await.unwrap();
            while let Some(item) = stream.next().await {
                item.unwrap();
            }
        })
        .await
        .unwrap();
        let headers = server.await.unwrap().unwrap();
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
        let client = GatewayClient::new("http://127.0.0.1:1/v1".to_string(), {
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
        let first = client.completion_model("first");
        let second = client.clone().completion_model("second");
        let (a, b) = tokio::join!(first.responses_model(), second.responses_model());
        a.unwrap();
        b.unwrap();
        assert_eq!(issued.load(Ordering::SeqCst), 1);
        let refresh_at = client.cached.lock().await.as_ref().unwrap().refresh_at;
        tokio::time::advance(refresh_at.duration_since(Instant::now()) - Duration::from_millis(1))
            .await;
        first.responses_model().await.unwrap();
        assert_eq!(issued.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_millis(1)).await;
        let (a, b) = tokio::join!(first.responses_model(), second.responses_model());
        a.unwrap();
        b.unwrap();
        assert_eq!(issued.load(Ordering::SeqCst), 2);
        tokio::time::advance(Duration::from_secs(37 * 60 * 60)).await;
        first.responses_model().await.unwrap();
        assert_eq!(issued.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn failed_refresh_can_retry_without_using_the_stale_credential() {
        let issued = Arc::new(AtomicUsize::new(0));
        let client = GatewayClient::new("http://127.0.0.1:1/v1".to_string(), {
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
        let model = client.completion_model("test-model");
        model.responses_model().await.unwrap();
        client.cached.lock().await.as_mut().unwrap().refresh_at = Instant::now();
        assert!(model.responses_model().await.is_err());
        model.responses_model().await.unwrap();
        assert_eq!(issued.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn credentials_within_the_refresh_headroom_are_rejected() {
        let issued = Arc::new(AtomicUsize::new(0));
        let client = GatewayClient::new("http://127.0.0.1:1/v1".to_string(), {
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
        let model = client.completion_model("test-model");
        for _ in 0..2 {
            let error = model.responses_model().await.err().unwrap();
            assert!(error.to_string().contains("too close to expiry"));
        }
        assert_eq!(issued.load(Ordering::SeqCst), 2);
        assert!(client.cached.lock().await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn wall_clock_expired_cache_entry_is_not_reused() {
        let issued = Arc::new(AtomicUsize::new(0));
        let client = GatewayClient::new("http://127.0.0.1:1/v1".to_string(), {
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
        let model = client.completion_model("test-model");
        model.responses_model().await.unwrap();
        // A wall-clock jump past expiry must force a refresh even though the
        // monotonic refresh deadline is still far ahead.
        client.cached.lock().await.as_mut().unwrap().expires_at = now_ms() - 1;
        model.responses_model().await.unwrap();
        assert_eq!(issued.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn credential_failures_reach_both_inference_paths() {
        let client = GatewayClient::new("http://127.0.0.1:1/v1".to_string(), || async {
            Err(anyhow::anyhow!("Run is no longer active."))
        });
        let model = client.completion_model("test-model");
        let error = model.completion(request()).await.unwrap_err();
        assert!(error.to_string().contains("Run is no longer active."));
        match model.stream(request()).await {
            Err(error) => assert!(error.to_string().contains("Run is no longer active.")),
            Ok(_) => panic!("a cancelled claim cannot start inference"),
        }
    }
}
