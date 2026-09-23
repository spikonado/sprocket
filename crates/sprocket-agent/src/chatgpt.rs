use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::Context;
use futures::{FutureExt, StreamExt, future::BoxFuture, stream::BoxStream};
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
type CredentialKey = (String, String, String);
type ConnectionUpdates = BoxStream<'static, anyhow::Result<Option<String>>>;

// Convex uses the same margin when deciding whether to rotate the token.
const REFRESH_MARGIN: Duration = Duration::from_secs(30);
const CONNECTION_QUERY: &str = "providerCredentials:chatGptConnection";

fn remaining_fresh_ms(credential: &ChatGptCredential) -> u64 {
    credential
        .expires_at
        .saturating_sub(now_ms())
        .saturating_sub(REFRESH_MARGIN.as_millis() as u64)
}

struct Connection {
    id: String,
    updates: ConnectionUpdates,
    valid: bool,
}

impl Connection {
    async fn new(mut updates: ConnectionUpdates) -> anyhow::Result<Self> {
        let id = tokio::time::timeout(Duration::from_secs(30), updates.next())
            .await
            .context("Timed out checking the ChatGPT connection.")?
            .context("ChatGPT connection subscription closed.")??
            .context("ChatGPT is no longer connected. Reconnect in Settings.")?;
        Ok(Self {
            id,
            updates,
            valid: true,
        })
    }

    fn check(&mut self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.valid,
            "ChatGPT connection changed or became unavailable. Start a new run."
        );
        while let Some(update) = self.updates.next().now_or_never() {
            self.valid = false;
            let id = update.context("ChatGPT connection subscription closed.")??;
            anyhow::ensure!(
                id.as_deref() == Some(self.id.as_str()),
                "ChatGPT connection changed. Start a new run."
            );
            self.valid = true;
        }
        Ok(())
    }
}

struct CachedCredential {
    credential: ChatGptCredential,
    expires: Instant,
}

impl CachedCredential {
    fn is_fresh(&self) -> bool {
        remaining_fresh_ms(&self.credential) > 0 && self.expires > Instant::now()
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
        let remaining_ms = remaining_fresh_ms(&credential);
        anyhow::ensure!(
            remaining_ms > 0,
            "ChatGPT returned an access token too close to expiry."
        );
        let expires = Instant::now()
            .checked_add(Duration::from_millis(remaining_ms))
            .context("ChatGPT returned an invalid token expiry.")?;
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
    connection: Arc<tokio::sync::Mutex<Connection>>,
    fetch: Arc<FetchCredential>,
    http: reqwest::Client,
}

impl ChatGptClient {
    pub(crate) async fn new(
        runtime: RuntimeClient,
        run_id: String,
        claim_id: String,
        deployment_url: String,
        user_id: String,
    ) -> anyhow::Result<Self> {
        static CACHES: OnceLock<CredentialCaches> = OnceLock::new();
        let updates = runtime
            .subscribe(
                CONNECTION_QUERY,
                BTreeMap::from([("runId".into(), convex::Value::String(run_id.clone()))]),
            )
            .await?;
        let connection = Connection::new(
            updates
                .map(|result| RuntimeClient::decode_subscription_update(result, CONNECTION_QUERY))
                .boxed(),
        )
        .await?;
        let connection_id = connection.id.clone();
        Ok(Self {
            cache: CACHES.get_or_init(CredentialCaches::default).get((
                deployment_url,
                user_id,
                connection_id,
            )),
            connection: Arc::new(tokio::sync::Mutex::new(connection)),
            fetch: Arc::new(move || {
                let runtime = runtime.clone();
                let run_id = run_id.clone();
                let claim_id = claim_id.clone();
                Box::pin(async move { runtime.issue_chatgpt_credential(&run_id, &claim_id).await })
            }),
            http: reqwest::Client::new(),
        })
    }

    async fn credential(&self) -> anyhow::Result<ChatGptCredential> {
        self.connection.lock().await.check()?;
        let credential = self.cache.resolve(&*self.fetch).await?;
        let mut connection = self.connection.lock().await;
        connection.check()?;
        anyhow::ensure!(
            credential.connection_id == connection.id,
            "ChatGPT connection changed during credential issuance. Start a new run."
        );
        Ok(credential)
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
            .credential()
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
            connection_id: "connection-1".into(),
            account_id: "account-1".into(),
            residency: None,
            expires_at: now_ms() + TOKEN_TTL.as_millis() as u64,
        }
    }

    fn cache_for(caches: &CredentialCaches, deployment: &str, user: &str) -> Arc<CredentialCache> {
        caches.get((
            deployment.to_string(),
            user.to_string(),
            "connection-1".into(),
        ))
    }

    fn credential_with_expiry(token: &str, expires_at: u64) -> ChatGptCredential {
        ChatGptCredential {
            expires_at,
            ..credential(token)
        }
    }

    type UpdatesSender = futures::channel::mpsc::UnboundedSender<anyhow::Result<Option<String>>>;

    fn send_id(sender: &UpdatesSender, id: Option<&str>) {
        sender.unbounded_send(Ok(id.map(str::to_string))).unwrap();
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

    async fn connected_client(fetch: Arc<FetchCredential>) -> (ChatGptClient, UpdatesSender) {
        let (sender, updates) = futures::channel::mpsc::unbounded();
        send_id(&sender, Some("connection-1"));
        let connection = Connection::new(updates.boxed()).await.unwrap();
        (
            ChatGptClient {
                cache: Arc::default(),
                connection: Arc::new(tokio::sync::Mutex::new(connection)),
                fetch,
                http: reqwest::Client::new(),
            },
            sender,
        )
    }

    #[tokio::test]
    async fn stops_cached_credential_use_on_disconnect_replacement_or_subscription_failure() {
        for update in [
            Ok(None),
            Ok(Some("connection-2".into())),
            Err(anyhow::anyhow!("unauthorized")),
        ] {
            let calls = Arc::new(AtomicUsize::new(0));
            let (client, updates) = connected_client(fetcher(&calls)).await;
            assert_eq!(client.credential().await.unwrap().access_token, "token-0");
            send_id(&updates, Some("connection-1"));
            assert_eq!(client.credential().await.unwrap().access_token, "token-0");
            updates.unbounded_send(update).unwrap();
            assert!(client.credential().await.is_err());
            send_id(&updates, Some("connection-1"));
            assert!(client.credential().await.is_err());
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn fails_closed_when_connection_subscription_ends() {
        let calls = Arc::new(AtomicUsize::new(0));
        let (client, updates) = connected_client(fetcher(&calls)).await;
        client.credential().await.unwrap();
        drop(updates);
        assert!(client.credential().await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn checks_connection_again_after_credential_fetch() {
        let calls = Arc::new(AtomicUsize::new(0));
        let (mut client, updates) = connected_client(fetcher(&calls)).await;
        client.fetch = Arc::new(move || {
            send_id(&updates, Some("connection-2"));
            Box::pin(async { Ok(credential("old-account-token")) })
        });
        assert!(client.credential().await.is_err());
    }

    #[tokio::test]
    async fn isolates_replacement_connections_in_the_shared_cache() {
        let caches = CredentialCaches::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let fetch = fetcher(&calls);
        let original = caches.get(("deployment".into(), "user".into(), "first-login".into()));
        assert_eq!(
            original.resolve(&*fetch).await.unwrap().access_token,
            "token-0"
        );
        let replacement = caches.get(("deployment".into(), "user".into(), "second-login".into()));
        assert_eq!(
            replacement.resolve(&*fetch).await.unwrap().access_token,
            "token-1"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn rejects_issuance_from_a_different_connection() {
        let (client, _updates) = connected_client(Arc::new(|| {
            Box::pin(async {
                Ok(ChatGptCredential {
                    connection_id: "connection-2".into(),
                    ..credential("replacement")
                })
            })
        }))
        .await;
        assert!(client.credential().await.is_err());
    }

    #[tokio::test]
    async fn rejects_near_expiry_issuance_and_accepts_a_fresh_token() {
        let cache = CredentialCache::default();
        assert!(
            cache
                .resolve(&|| Box::pin(async {
                    Ok(credential_with_expiry("near-expiry", now_ms() + 10_000))
                }))
                .await
                .is_err()
        );
        let calls = Arc::new(AtomicUsize::new(0));
        assert_eq!(
            cache.resolve(&*fetcher(&calls)).await.unwrap().access_token,
            "token-0"
        );
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
        tokio::time::advance(TOKEN_TTL - REFRESH_MARGIN - Duration::from_secs(1)).await;
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
            credential: credential_with_expiry("expired-during-suspend", now_ms()),
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
        let expired: Arc<FetchCredential> =
            Arc::new(|| Box::pin(async { Ok(credential_with_expiry("expired", now_ms())) }));
        assert!(cache.resolve(&*expired).await.is_err());
        let calls = Arc::new(AtomicUsize::new(0));
        assert_eq!(
            cache.resolve(&*fetcher(&calls)).await.unwrap().access_token,
            "token-0"
        );
    }
}
