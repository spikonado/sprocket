use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use convex::{AuthenticationToken, ConvexClient, FunctionResult, QuerySubscription, Value};
use rustls::crypto::ring::default_provider;
use tokio::sync::Mutex;
use tokio::time::timeout;

mod decode;

pub use decode::{
    decode_function_result, decode_labeled_function_result, deserialize_convex_u32,
    deserialize_convex_u64,
};

const CONVEX_RPC_TIMEOUT: Duration = Duration::from_secs(20 * 60);

pub type AuthTokenFetcher =
    Arc<dyn Fn(bool) -> Pin<Box<dyn Future<Output = anyhow::Result<String>> + Send>> + Send + Sync>;

#[derive(Clone)]
pub struct Client {
    inner: Arc<Mutex<ConvexClient>>,
}

impl Client {
    pub async fn new(deployment_url: &str) -> anyhow::Result<Self> {
        let _ = default_provider().install_default();
        let client = ConvexClient::new(deployment_url)
            .await
            .context("failed to initialize Convex client")?;
        Ok(Self {
            inner: Arc::new(Mutex::new(client)),
        })
    }

    pub async fn set_auth_token_fetcher(&self, fetcher: AuthTokenFetcher) {
        self.inner
            .lock()
            .await
            .set_auth_callback(Some(convex_auth_fetcher(fetcher)))
            .await;
    }

    pub async fn clear_auth(&self) {
        self.inner.lock().await.set_auth_callback(None).await;
    }

    pub async fn query(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<FunctionResult> {
        let mut convex = clone_locked(&self.inner).await;
        timeout(CONVEX_RPC_TIMEOUT, convex.query(function, args))
            .await
            .with_context(|| format!("query timed out for {function}"))?
            .map_err(Into::into)
    }

    pub async fn subscribe(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<QuerySubscription> {
        let mut convex = clone_locked(&self.inner).await;
        timeout(CONVEX_RPC_TIMEOUT, convex.subscribe(function, args))
            .await
            .with_context(|| format!("subscription timed out for {function}"))?
            .map_err(Into::into)
    }

    pub async fn mutation(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<FunctionResult> {
        let mut convex = clone_locked(&self.inner).await;
        timeout(CONVEX_RPC_TIMEOUT, convex.mutation(function, args))
            .await
            .with_context(|| format!("mutation timed out for {function}"))?
            .map_err(Into::into)
    }

    pub async fn action(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<FunctionResult> {
        let mut convex = clone_locked(&self.inner).await;
        timeout(CONVEX_RPC_TIMEOUT, convex.action(function, args))
            .await
            .with_context(|| format!("action timed out for {function}"))?
            .map_err(Into::into)
    }
}

async fn clone_locked<T: Clone>(inner: &Mutex<T>) -> T {
    inner.lock().await.clone()
}

fn convex_auth_fetcher(fetcher: AuthTokenFetcher) -> convex::AuthTokenFetcher {
    Box::new(move |force_refresh| {
        let fetcher = fetcher.clone();
        Box::pin(async move { fetcher(force_refresh).await.map(AuthenticationToken::User) })
    })
}
