use std::time::Duration;

use anyhow::{Context, anyhow};

use crate::types::{CatalogModelCapabilities, ContextBudget, gateway_api_v1_url};

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
    supports_images: bool,
    context_window_tokens: u64,
    auto_compact_token_limit: u64,
}

fn select_catalog_model(
    payload: GatewayModelsResponse,
    model_id: &str,
) -> anyhow::Result<CatalogModelCapabilities> {
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
    Ok(CatalogModelCapabilities {
        context_budget: ContextBudget {
            context_window_tokens: model.context_window_tokens,
            auto_compact_token_limit: model.auto_compact_token_limit,
        },
        supports_images: model.supports_images,
    })
}

/// Fetch context budget and `supportsImages` for `model_id` from one catalog GET.
pub async fn catalog_capabilities_for_model(
    gateway_url: &str,
    model_id: &str,
) -> anyhow::Result<CatalogModelCapabilities> {
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
    select_catalog_model(payload, model_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog_payload(supports_images: bool) -> GatewayModelsResponse {
        serde_json::from_value(serde_json::json!({
            "sprocket": {
                "protocolVersion": 1,
                "models": [
                    {
                        "id": "gpt-5.6-sol",
                        "supportsImages": supports_images,
                        "contextWindowTokens": 272000,
                        "autoCompactTokenLimit": 258000
                    },
                    {
                        "id": "deepseek-v4-pro-0813",
                        "supportsImages": false,
                        "contextWindowTokens": 1000000,
                        "autoCompactTokenLimit": 967000
                    }
                ]
            }
        }))
        .expect("catalog payload")
    }

    #[test]
    fn fixture_reports_image_capability_with_budget_from_one_payload() {
        let vision =
            select_catalog_model(catalog_payload(true), "gpt-5.6-sol").expect("vision model");
        assert!(vision.supports_images);
        assert_eq!(vision.context_budget.context_window_tokens, 272000);
        assert_eq!(vision.context_budget.auto_compact_token_limit, 258000);

        let text = select_catalog_model(catalog_payload(true), "deepseek-v4-pro-0813")
            .expect("text model");
        assert!(!text.supports_images);
        assert_eq!(text.context_budget.context_window_tokens, 1_000_000);
    }

    #[test]
    fn missing_catalog_model_is_an_error() {
        let error = select_catalog_model(catalog_payload(true), "no-such-model")
            .expect_err("unknown model")
            .to_string();
        assert!(error.contains("no-such-model"));
    }

    #[test]
    fn catalog_model_requires_supports_images() {
        let error = serde_json::from_value::<GatewayCatalogModel>(serde_json::json!({
            "id": "gpt-5.6-sol",
            "contextWindowTokens": 272000,
            "autoCompactTokenLimit": 258000
        }))
        .expect_err("supportsImages is required");
        assert!(error.to_string().contains("supportsImages"));
    }
}
