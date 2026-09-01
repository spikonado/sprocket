use std::time::Duration;

use anyhow::{Context, anyhow};

use crate::types::{ContextBudget, gateway_api_v1_url};

const GATEWAY_PROTOCOL_VERSION: u64 = 1;
const CATALOG_TIMEOUT: Duration = Duration::from_secs(15);

fn catalog_client(gateway_url: &str) -> anyhow::Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder().timeout(CATALOG_TIMEOUT);
    if let Some(host) = reqwest::Url::parse(gateway_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
    {
        builder = builder.retry(reqwest::retry::for_host(host).classify_fn(|req_rep| {
            if *req_rep.method() != reqwest::Method::GET {
                return req_rep.success();
            }
            if req_rep.error().is_some() {
                return req_rep.retryable();
            }
            match req_rep.status().map(|status| status.as_u16()) {
                Some(429 | 502 | 503 | 504) => req_rep.retryable(),
                _ => req_rep.success(),
            }
        }));
    }
    builder
        .build()
        .context("failed to build AI gateway catalog HTTP client")
}

#[derive(Debug, serde::Deserialize)]
struct GatewayModelsResponse {
    sprocket: GatewaySprocketCatalog,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewaySprocketCatalog {
    protocol_version: u64,
    models: Vec<GatewayCatalogModel>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayCatalogModel {
    id: String,
    context_window_tokens: u64,
    auto_compact_token_limit: u64,
}

pub async fn context_budget_for_model(
    gateway_url: &str,
    model_id: &str,
) -> anyhow::Result<ContextBudget> {
    let url = format!("{}/models", gateway_api_v1_url(gateway_url));
    let response = catalog_client(gateway_url)?
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .context("failed to fetch AI gateway catalog")?;
    if !response.status().is_success() {
        anyhow::bail!("AI gateway catalog returned {}", response.status());
    }
    let payload: GatewayModelsResponse = response
        .json()
        .await
        .context("AI gateway catalog was not valid JSON")?;
    if payload.sprocket.protocol_version != GATEWAY_PROTOCOL_VERSION {
        anyhow::bail!(
            "unsupported AI gateway protocol version {}",
            payload.sprocket.protocol_version
        );
    }
    let model = payload
        .sprocket
        .models
        .iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| anyhow!("model {model_id} is not in the AI gateway catalog"))?;
    Ok(ContextBudget {
        context_window_tokens: model.context_window_tokens,
        auto_compact_token_limit: model.auto_compact_token_limit,
    })
}
