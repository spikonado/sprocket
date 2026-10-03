use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use rig::DynModel;
use rig::http_client::{
    self, DynHttpClient, HeaderMap, HttpMiddleware, Method, ReqwestClient, Uri, bearer_auth_header,
};
use rig::operation::Completion;
use rig::providers::openai::OpenAIConfig;
use rig::wasm_compat::WasmBoxedFuture;
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::live::now_ms;
use crate::types::GatewayCredential;

const REFRESH_HEADROOM_MS: u64 = 60_000;
const GATEWAY_MANAGED_KEY: &str = "gateway-managed-by-transport";

struct CachedCredential {
    token: String,
    expires_at: u64,
    refresh_at: Instant,
}

#[derive(Clone)]
struct GatewayAuth<F> {
    issue_credential: F,
    cached: Arc<Mutex<Option<CachedCredential>>>,
}

async fn resolve_credential<F, Fut>(
    issue_credential: &F,
    cached: &Mutex<Option<CachedCredential>>,
) -> http_client::Result<String>
where
    F: Fn() -> Fut,
    Fut: Future<Output = anyhow::Result<GatewayCredential>>,
{
    let mut cached = cached.lock().await;
    if let Some(cached) = cached.as_ref()
        && Instant::now() < cached.refresh_at
        && cached.expires_at.saturating_sub(now_ms()) > REFRESH_HEADROOM_MS
    {
        return Ok(cached.token.clone());
    }
    let credential = issue_credential()
        .await
        .map_err(|error| http_client::Error::Instance(error.into()))?;
    let remaining_ms = credential.expires_at.saturating_sub(now_ms());
    if remaining_ms <= REFRESH_HEADROOM_MS {
        return Err(http_client::Error::Instance(
            "Gateway returned a credential too close to expiry.".into(),
        ));
    }
    let token = credential.token.clone();
    *cached = Some(CachedCredential {
        token: token.clone(),
        expires_at: credential.expires_at,
        refresh_at: Instant::now() + Duration::from_millis(remaining_ms - REFRESH_HEADROOM_MS),
    });
    Ok(token)
}

impl<F, Fut> HttpMiddleware for GatewayAuth<F>
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = anyhow::Result<GatewayCredential>> + Send + 'static,
{
    fn before_request_headers<'a>(
        &'a self,
        _method: &'a Method,
        _uri: &'a Uri,
        headers: &'a mut HeaderMap,
    ) -> WasmBoxedFuture<'a, http_client::Result<()>> {
        Box::pin(async move {
            let token = resolve_credential(&self.issue_credential, &self.cached).await?;
            bearer_auth_header(headers, token)?;
            Ok(())
        })
    }
}

#[derive(Clone)]
pub(crate) struct GatewayClient<F> {
    base_url: String,
    http: DynHttpClient,
    // Tests inspect and refresh through this shared cache; live requests use GatewayAuth.
    #[cfg_attr(not(test), allow(dead_code))]
    issue_credential: F,
    #[cfg_attr(not(test), allow(dead_code))]
    cached: Arc<Mutex<Option<CachedCredential>>>,
}

impl<F, Fut> GatewayClient<F>
where
    F: Fn() -> Fut + Clone + Send + Sync + 'static,
    Fut: Future<Output = anyhow::Result<GatewayCredential>> + Send + 'static,
{
    pub(crate) fn new(base_url: String, issue_credential: F) -> Self {
        let cached = Arc::default();
        let http = DynHttpClient::new(ReqwestClient::from(reqwest::Client::new())).with_middleware(
            GatewayAuth {
                issue_credential: issue_credential.clone(),
                cached: Arc::clone(&cached),
            },
        );
        Self {
            base_url,
            http,
            issue_credential,
            cached,
        }
    }

    pub(crate) fn completion_model(&self, model: impl Into<String>) -> DynModel<Completion> {
        OpenAIConfig::new(GATEWAY_MANAGED_KEY)
            .with_base_url(&self.base_url)
            .connect(self.http.clone())
            .responses(model)
            .erase()
    }

    #[cfg(test)]
    async fn resolve_credential(&self) -> http_client::Result<String> {
        resolve_credential(&self.issue_credential, &self.cached).await
    }
}

#[cfg(test)]
mod tests {
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
        CompletionRequest::new("hello")
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
                    Ok::<_, anyhow::Error>(GatewayCredential {
                        token: format!("token-{number}"),
                        expires_at: now_ms() + 36 * 60 * 60 * 1000,
                    })
                }
            }
        });
        let model = client.completion_model("test-model");
        timeout(TEST_TIMEOUT, model.call(request()))
            .await
            .unwrap()
            .unwrap();
        timeout(TEST_TIMEOUT, model.call(request()))
            .await
            .unwrap()
            .unwrap();
        client.cached.lock().await.as_mut().unwrap().refresh_at = Instant::now();
        timeout(TEST_TIMEOUT, async {
            let mut stream = model.stream(request()).unwrap();
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
        let cloned = client.clone();
        let (a, b) = tokio::join!(client.resolve_credential(), cloned.resolve_credential());
        a.unwrap();
        b.unwrap();
        assert_eq!(issued.load(Ordering::SeqCst), 1);
        let refresh_at = client.cached.lock().await.as_ref().unwrap().refresh_at;
        tokio::time::advance(refresh_at.duration_since(Instant::now()) - Duration::from_millis(1))
            .await;
        client.resolve_credential().await.unwrap();
        assert_eq!(issued.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_millis(1)).await;
        let cloned = client.clone();
        let (a, b) = tokio::join!(client.resolve_credential(), cloned.resolve_credential());
        a.unwrap();
        b.unwrap();
        assert_eq!(issued.load(Ordering::SeqCst), 2);
        tokio::time::advance(Duration::from_secs(37 * 60 * 60)).await;
        client.resolve_credential().await.unwrap();
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
        client.resolve_credential().await.unwrap();
        client.cached.lock().await.as_mut().unwrap().refresh_at = Instant::now();
        assert!(client.resolve_credential().await.is_err());
        client.resolve_credential().await.unwrap();
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
        for _ in 0..2 {
            let error = client.resolve_credential().await.err().unwrap();
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
        client.resolve_credential().await.unwrap();
        // A wall-clock jump past expiry must force a refresh even though the
        // monotonic refresh deadline is still far ahead.
        client.cached.lock().await.as_mut().unwrap().expires_at = now_ms() - 1;
        client.resolve_credential().await.unwrap();
        assert_eq!(issued.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn credential_failures_reach_both_inference_paths() {
        let client = GatewayClient::new("http://127.0.0.1:1/v1".to_string(), || async {
            Err::<GatewayCredential, _>(anyhow::anyhow!("Run is no longer active."))
        });
        let model = client.completion_model("test-model");
        let error = model.call(request()).await.unwrap_err();
        assert!(error.to_string().contains("Run is no longer active."));
        let mut stream = model.stream(request()).unwrap();
        match stream.next().await {
            Some(Err(error)) => assert!(error.to_string().contains("Run is no longer active.")),
            other => panic!("a cancelled claim cannot start inference: {other:?}"),
        }
    }
}
