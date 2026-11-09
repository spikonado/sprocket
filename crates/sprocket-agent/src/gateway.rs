use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use rig::http_client::{
    self, DynHttpClient, Exchange, HeaderMap, HeaderValue, HttpMiddleware, ReqwestClient,
};
use rig::operation::Completion;
use rig::wasm_compat::WasmBoxedFuture;
use rig::{DynModel, Model};
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::now_ms;
use crate::openai::{developer_messages, transport_auth_config};
use crate::request_compression::ZstdResponsesRequests;
use crate::types::GatewayCredential;

const REFRESH_HEADROOM_MS: u64 = 60_000;

struct CachedCredential {
    token: String,
    expires_at: u64,
    refresh_at: Instant,
}

impl CachedCredential {
    fn fresh(credential: GatewayCredential) -> Option<Self> {
        let remaining_ms = credential.expires_at.saturating_sub(now_ms());
        (remaining_ms > REFRESH_HEADROOM_MS).then(|| Self {
            token: credential.token,
            expires_at: credential.expires_at,
            refresh_at: Instant::now() + Duration::from_millis(remaining_ms - REFRESH_HEADROOM_MS),
        })
    }
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
    fn new(credential: Option<GatewayCredential>, issue_credential: F) -> Self {
        Self {
            issue_credential,
            cached: Arc::new(Mutex::new(credential.and_then(CachedCredential::fresh))),
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
        let fresh = CachedCredential::fresh(credential).ok_or_else(|| {
            http_client::Error::Instance(
                "Gateway returned a credential too close to expiry.".into(),
            )
        })?;
        let token = fresh.token.clone();
        *cached = Some(fresh);
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
        _exchange: Exchange<'a>,
        headers: &'a mut HeaderMap,
    ) -> WasmBoxedFuture<'a, http_client::Result<()>> {
        Box::pin(async move {
            let token = self.resolve_credential().await?;
            let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))?;
            authorization.set_sensitive(true);
            headers.insert(http::header::AUTHORIZATION, authorization);
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
    pub(crate) fn new<F, Fut>(
        base_url: String,
        credential: GatewayCredential,
        issue_credential: F,
    ) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = anyhow::Result<GatewayCredential>> + Send + 'static,
    {
        let auth = GatewayAuth::new(Some(credential), issue_credential);
        let http = DynHttpClient::new(ReqwestClient::from(reqwest::Client::new()))
            .with_middleware(auth)
            .with_middleware(ZstdResponsesRequests);
        Self { base_url, http }
    }

    pub(crate) fn completion_model(
        &self,
        model: impl Into<String>,
        instructions: &str,
    ) -> DynModel<Completion> {
        let model = transport_auth_config()
            .with_base_url(&self.base_url)
            .with_instructions(instructions)
            .connect(self.http.clone())
            .responses(model);
        Model::new(developer_messages(model.wire), model.transport).erase()
    }
}

#[cfg(test)]
mod tests;
