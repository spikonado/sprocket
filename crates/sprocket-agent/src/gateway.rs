use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use rig::http_client::{
    self, DynHttpClient, HeaderMap, HttpMiddleware, Method, ReqwestClient, Uri, bearer_auth_header,
};
use rig::operation::Completion;
use rig::providers::openai::OpenAIConfig;
use rig::wasm_compat::WasmBoxedFuture;
use rig::{DynModel, Model};
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::now_ms;
use crate::openai::DeveloperResponses;
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

impl<F, Fut> GatewayAuth<F>
where
    F: Fn() -> Fut,
    Fut: Future<Output = anyhow::Result<GatewayCredential>>,
{
    fn new(issue_credential: F) -> Self {
        Self {
            issue_credential,
            cached: Arc::default(),
        }
    }

    async fn resolve_credential(&self) -> http_client::Result<String> {
        let mut cached = self.cached.lock().await;
        if let Some(cached) = cached.as_ref()
            && Instant::now() < cached.refresh_at
            && cached.expires_at.saturating_sub(now_ms()) > REFRESH_HEADROOM_MS
        {
            return Ok(cached.token.clone());
        }
        let credential = (self.issue_credential)()
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
            let token = self.resolve_credential().await?;
            bearer_auth_header(headers, token)?;
            Ok(())
        })
    }
}

#[derive(Clone)]
pub(crate) struct GatewayClient {
    base_url: String,
    http: DynHttpClient,
}

impl GatewayClient {
    pub(crate) fn new<F, Fut>(base_url: String, issue_credential: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = anyhow::Result<GatewayCredential>> + Send + 'static,
    {
        let auth = GatewayAuth::new(issue_credential);
        let http =
            DynHttpClient::new(ReqwestClient::from(reqwest::Client::new())).with_middleware(auth);
        Self { base_url, http }
    }

    pub(crate) fn completion_model(
        &self,
        model: impl Into<String>,
        instructions: &str,
    ) -> DynModel<Completion> {
        let model = OpenAIConfig::new(GATEWAY_MANAGED_KEY)
            .with_base_url(&self.base_url)
            .with_instructions(instructions)
            .connect(self.http.clone())
            .responses(model);
        Model::new(DeveloperResponses(model.wire), model.transport).erase()
    }
}

#[cfg(test)]
mod tests;
