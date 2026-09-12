use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Weak};
use std::time::Duration;

use anyhow::Context;
use convex::{AuthenticationToken, ConvexClient, FunctionResult, QuerySubscription, Value};
use rustls::crypto::ring::default_provider;
use tokio::sync::Mutex;
use tokio::time::timeout;

mod auth;
mod decode;
#[cfg(test)]
mod tests;

use auth::AuthState;
pub use decode::{
    decode_function_result, decode_labeled_function_result, deserialize_convex_u32,
    deserialize_convex_u64,
};

const CONVEX_RPC_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// The boolean requests a fresh JWT. Return `AuthSignedOut` only for a terminal session failure.
pub type AuthTokenFetcher =
    Arc<dyn Fn(bool) -> Pin<Box<dyn Future<Output = anyhow::Result<String>> + Send>> + Send + Sync>;

#[derive(Debug)]
pub struct AuthSignedOut;

impl std::fmt::Display for AuthSignedOut {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("authentication session is signed out")
    }
}

impl std::error::Error for AuthSignedOut {}

struct Inner {
    convex: Mutex<Option<ConvexClient>>,
    auth: Arc<AuthState>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.auth.shutdown();
    }
}

#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

impl Client {
    pub async fn new(deployment_url: &str) -> anyhow::Result<Self> {
        let _ = default_provider().install_default();
        let client = ConvexClient::new(deployment_url)
            .await
            .context("failed to initialize Convex client")?;
        let inner = Arc::new(Inner {
            convex: Mutex::new(Some(client)),
            auth: AuthState::new(),
        });
        let inner_weak = Arc::downgrade(&inner);
        inner.auth.set_on_apply(Arc::new(move |generation| {
            let inner_weak = inner_weak.clone();
            Box::pin(async move {
                apply_pending_token(inner_weak, generation).await;
            })
        }));
        let inner_weak = Arc::downgrade(&inner);
        inner
            .auth
            .set_on_failure(Arc::new(move |generation, error| {
                Box::pin(close_failed_connection(
                    inner_weak.clone(),
                    generation,
                    error,
                ))
            }));
        Ok(Self { inner })
    }

    pub async fn set_auth_token_fetcher(&self, fetcher: AuthTokenFetcher) -> anyhow::Result<()> {
        let mut convex = self.inner.convex.lock().await;
        let convex = convex.as_mut().context("Convex connection is closed")?;
        let generation = self.inner.auth.install(fetcher).await;
        convex
            .set_auth_callback(Some(sdk_fetcher(
                Arc::downgrade(&self.inner.auth),
                generation,
            )))
            .await;
        Ok(())
    }

    pub async fn clear_auth(&self) {
        let mut convex = self.inner.convex.lock().await;
        self.inner.auth.clear().await;
        if let Some(convex) = convex.as_mut() {
            convex.set_auth_callback(None).await;
        }
    }

    pub async fn query(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<FunctionResult> {
        self.with_auth_failure(async {
            let mut convex = self.connected_client().await?;
            timeout(CONVEX_RPC_TIMEOUT, convex.query(function, args))
                .await
                .with_context(|| format!("query timed out for {function}"))?
                .map_err(Into::into)
        })
        .await
    }

    pub async fn subscribe(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<QuerySubscription> {
        self.with_auth_failure(async {
            let mut convex = self.connected_client().await?;
            timeout(CONVEX_RPC_TIMEOUT, convex.subscribe(function, args))
                .await
                .with_context(|| format!("subscription timed out for {function}"))?
                .map_err(Into::into)
        })
        .await
    }

    pub async fn watch_all(&self) -> anyhow::Result<convex::QuerySetSubscription> {
        Ok(self.connected_client().await?.watch_all())
    }

    pub async fn mutation(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<FunctionResult> {
        self.with_auth_failure(async {
            let mut convex = self.connected_client().await?;
            timeout(CONVEX_RPC_TIMEOUT, convex.mutation(function, args))
                .await
                .with_context(|| format!("mutation timed out for {function}"))?
                .map_err(Into::into)
        })
        .await
    }

    pub async fn action(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<FunctionResult> {
        self.with_auth_failure(async {
            let mut convex = self.connected_client().await?;
            timeout(CONVEX_RPC_TIMEOUT, convex.action(function, args))
                .await
                .with_context(|| format!("action timed out for {function}"))?
                .map_err(Into::into)
        })
        .await
    }

    async fn connected_client(&self) -> anyhow::Result<ConvexClient> {
        self.inner
            .convex
            .lock()
            .await
            .clone()
            .context("Convex connection is closed")
    }

    async fn with_auth_failure<T>(
        &self,
        operation: impl Future<Output = anyhow::Result<T>>,
    ) -> anyhow::Result<T> {
        tokio::select! {
            biased;
            error = self.inner.auth.wait_for_failure() => Err(anyhow::anyhow!(error)),
            result = operation => result,
        }
    }
}

fn sdk_fetcher(auth: Weak<AuthState>, generation: u64) -> convex::AuthTokenFetcher {
    Box::new(move |force_refresh| {
        let auth = auth.clone();
        Box::pin(async move {
            let auth = auth.upgrade().context("convex client dropped")?;
            let token = match auth.resolve(generation, force_refresh).await {
                Ok(token) => token,
                Err(error) if error.is::<AuthSignedOut>() => return Ok(AuthenticationToken::None),
                Err(error) => return Err(error),
            };
            auth.arm(generation, &token).await;
            Ok(AuthenticationToken::User(token))
        })
    })
}

async fn apply_pending_token(inner: Weak<Inner>, generation: u64) {
    let Some(inner) = inner.upgrade() else {
        return;
    };
    let mut convex = inner.convex.lock().await;
    if inner.auth.generation() != generation {
        return;
    }
    let Some(convex) = convex.as_mut() else {
        return;
    };
    convex
        .set_auth_callback(Some(sdk_fetcher(Arc::downgrade(&inner.auth), generation)))
        .await;
}

async fn close_failed_connection(inner: Weak<Inner>, generation: u64, error: String) -> bool {
    let Some(inner) = inner.upgrade() else {
        return false;
    };
    let mut convex = inner.convex.lock().await;
    if inner.auth.generation() == generation {
        inner.auth.report_failure(error);
        convex.take();
        return true;
    }
    false
}
