use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures::future::BoxFuture;
use rig::client::CompletionClient;
use rig::completion::{CompletionError, CompletionModel, CompletionRequest, CompletionResponse};
use rig::http_client::{HeaderMap, HeaderValue};
use rig::providers::chatgpt;
use rig::streaming::StreamingCompletionResponse;
use tokio::time::Instant;

use crate::convex::RuntimeClient;
use crate::live::now_ms;
use crate::types::ChatGptCredential;

type FetchCredential =
    dyn Fn() -> BoxFuture<'static, anyhow::Result<ChatGptCredential>> + Send + Sync;
type CredentialKey = (String, String);

struct CachedCredential {
    credential: ChatGptCredential,
    expires: Instant,
}

impl CachedCredential {
    fn is_fresh(&self) -> bool {
        self.credential.expires_at > now_ms() && self.expires > Instant::now()
    }
}

#[derive(Default)]
struct CredentialCache(tokio::sync::Mutex<Option<CachedCredential>>);

impl CredentialCache {
    async fn resolve(&self, fetch: &FetchCredential) -> anyhow::Result<ChatGptCredential> {
        // Hold the guard across the fetch so concurrent callers share one issuance.
        let mut cached = self.0.lock().await;
        if let Some(cached) = cached.as_ref()
            && cached.is_fresh()
        {
            return Ok(cached.credential.clone());
        }
        cached.take();
        let credential = fetch().await?;
        let remaining_ms = credential.expires_at.saturating_sub(now_ms());
        anyhow::ensure!(
            remaining_ms > 0,
            "ChatGPT returned an expired access token."
        );
        let expires = Instant::now()
            .checked_add(Duration::from_millis(remaining_ms))
            .ok_or_else(|| anyhow::anyhow!("ChatGPT returned an invalid token expiry."))?;
        *cached = Some(CachedCredential {
            credential: credential.clone(),
            expires,
        });
        Ok(credential)
    }

    fn is_live(&self) -> bool {
        self.0.try_lock().map_or(true, |cached| {
            cached.as_ref().is_some_and(CachedCredential::is_fresh)
        })
    }
}

#[derive(Default)]
struct CredentialCaches(Mutex<HashMap<CredentialKey, Arc<CredentialCache>>>);

impl CredentialCaches {
    fn get(&self, key: CredentialKey) -> Arc<CredentialCache> {
        let mut caches = self.0.lock().unwrap_or_else(|error| error.into_inner());
        caches.retain(|_, cache| Arc::strong_count(cache) > 1 || cache.is_live());
        Arc::clone(caches.entry(key).or_default())
    }
}

#[derive(Clone)]
pub(crate) struct ChatGptClient {
    cache: Arc<CredentialCache>,
    fetch: Arc<FetchCredential>,
    http: reqwest::Client,
}

impl ChatGptClient {
    pub(crate) fn new(
        runtime: RuntimeClient,
        run_id: String,
        claim_id: String,
        deployment_url: String,
        user_id: String,
    ) -> Self {
        static CACHES: OnceLock<CredentialCaches> = OnceLock::new();
        Self {
            cache: CACHES
                .get_or_init(CredentialCaches::default)
                .get((deployment_url, user_id)),
            fetch: Arc::new(move || {
                let runtime = runtime.clone();
                let run_id = run_id.clone();
                let claim_id = claim_id.clone();
                Box::pin(async move { runtime.issue_chatgpt_credential(&run_id, &claim_id).await })
            }),
            http: reqwest::Client::new(),
        }
    }
}

impl CompletionClient for ChatGptClient {
    type CompletionModel = ChatGptModel;

    fn completion_model(&self, model: impl Into<String>) -> Self::CompletionModel {
        ChatGptModel {
            client: self.clone(),
            model: model.into(),
        }
    }
}

pub(crate) struct ChatGptModel {
    client: ChatGptClient,
    model: String,
}

impl ChatGptModel {
    async fn authorized_model(&self) -> Result<chatgpt::ResponsesCompletionModel, CompletionError> {
        let credential = self
            .client
            .cache
            .resolve(&*self.client.fetch)
            .await
            .map_err(|error| CompletionError::RequestError(error.into()))?;
        let mut headers = HeaderMap::new();
        if let Some(residency) = credential.residency {
            headers.insert(
                "x-openai-internal-codex-residency",
                HeaderValue::from_str(&residency).map_err(rig::http_client::Error::from)?,
            );
        }
        let client = chatgpt::Client::builder()
            .api_key(chatgpt::ChatGPTAuth::AccessToken {
                access_token: credential.access_token,
                account_id: Some(credential.account_id),
            })
            .http_client(self.client.http.clone())
            .http_headers(headers)
            .originator("sprocket")
            .user_agent(format!("Sprocket/{}", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(client.completion_model(&self.model))
    }
}

impl CompletionModel for ChatGptModel {
    async fn completion(
        &self,
        request: CompletionRequest,
    ) -> Result<CompletionResponse, CompletionError> {
        self.authorized_model().await?.completion(request).await
    }

    async fn stream(
        &self,
        request: CompletionRequest,
    ) -> Result<StreamingCompletionResponse, CompletionError> {
        self.authorized_model().await?.stream(request).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    const TOKEN_TTL: Duration = Duration::from_secs(60);

    fn credential(token: &str) -> ChatGptCredential {
        ChatGptCredential {
            access_token: token.into(),
            account_id: "account-1".into(),
            residency: None,
            expires_at: now_ms() + TOKEN_TTL.as_millis() as u64,
        }
    }

    fn cache_for(caches: &CredentialCaches, deployment: &str, user: &str) -> Arc<CredentialCache> {
        caches.get((deployment.to_string(), user.to_string()))
    }

    fn fetcher(calls: &Arc<AtomicUsize>) -> Arc<FetchCredential> {
        let calls = Arc::clone(calls);
        Arc::new(move || {
            let call = calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                tokio::task::yield_now().await;
                Ok(credential(&format!("token-{call}")))
            })
        })
    }

    #[tokio::test(start_paused = true)]
    async fn reuses_tokens_across_runs_and_fetches_once_after_expiry() {
        let caches = CredentialCaches::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let fetch = fetcher(&calls);
        let first_run = cache_for(&caches, "deployment-1", "user-1");
        assert_eq!(
            first_run.resolve(&*fetch).await.unwrap().access_token,
            "token-0"
        );
        drop(first_run);

        let second_run = cache_for(&caches, "deployment-1", "user-1");
        tokio::time::advance(TOKEN_TTL - Duration::from_secs(1)).await;
        assert_eq!(
            second_run.resolve(&*fetch).await.unwrap().access_token,
            "token-0"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let third_run = cache_for(&caches, "deployment-1", "user-1");
        tokio::time::advance(Duration::from_secs(2)).await;
        let (second, third) = tokio::join!(second_run.resolve(&*fetch), third_run.resolve(&*fetch));
        assert_eq!(second.unwrap().access_token, "token-1");
        assert_eq!(third.unwrap().access_token, "token-1");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn isolates_users_and_deployments_and_drops_idle_expired_entries() {
        let caches = CredentialCaches::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let fetch = fetcher(&calls);
        for (deployment, user) in [("d1", "u1"), ("d2", "u1"), ("d1", "u2")] {
            cache_for(&caches, deployment, user)
                .resolve(&*fetch)
                .await
                .unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert_eq!(caches.0.lock().unwrap().len(), 3);
        tokio::time::advance(TOKEN_TTL + Duration::from_secs(1)).await;
        let cache = cache_for(&caches, "d1", "u1");
        assert_eq!(caches.0.lock().unwrap().len(), 1);
        assert_eq!(
            cache.resolve(&*fetch).await.unwrap().access_token,
            "token-3"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn retries_failed_issuance_on_the_next_request() {
        let cache = CredentialCache::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let fetch = fetcher(&calls);
        cache.resolve(&*fetch).await.unwrap();
        tokio::time::advance(TOKEN_TTL + Duration::from_secs(1)).await;
        assert!(
            cache
                .resolve(&|| Box::pin(async { anyhow::bail!("issuer unavailable") }))
                .await
                .is_err()
        );
        assert_eq!(
            cache.resolve(&*fetch).await.unwrap().access_token,
            "token-1"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn fetches_after_wall_clock_expiry_even_if_monotonic_time_has_not_elapsed() {
        let cache = CredentialCache(tokio::sync::Mutex::new(Some(CachedCredential {
            credential: ChatGptCredential {
                expires_at: now_ms(),
                ..credential("expired-during-suspend")
            },
            expires: Instant::now() + TOKEN_TTL,
        })));
        let calls = Arc::new(AtomicUsize::new(0));
        assert_eq!(
            cache.resolve(&*fetcher(&calls)).await.unwrap().access_token,
            "token-0"
        );
    }

    #[tokio::test]
    async fn accepts_a_fresh_credential_after_an_expired_issuer_response() {
        let cache = CredentialCache::default();
        let expired: Arc<FetchCredential> = Arc::new(|| {
            Box::pin(async {
                Ok(ChatGptCredential {
                    expires_at: now_ms(),
                    ..credential("expired")
                })
            })
        });
        assert!(cache.resolve(&*expired).await.is_err());
        let calls = Arc::new(AtomicUsize::new(0));
        assert_eq!(
            cache.resolve(&*fetcher(&calls)).await.unwrap().access_token,
            "token-0"
        );
    }
}
