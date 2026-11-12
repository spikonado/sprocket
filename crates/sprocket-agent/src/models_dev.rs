use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Context;
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::types::ModelRoute;

const API_URL: &str = "https://models.dev/api.json";
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const REFRESH_AFTER: Duration = Duration::from_secs(6 * 60 * 60);
const RETRY_AFTER: Duration = Duration::from_secs(60);

/// models.dev ID → models.dev provider ID → that provider's model ID.
type Index = HashMap<String, HashMap<&'static str, String>>;

#[derive(Deserialize)]
struct Api {
    anthropic: Option<Provider>,
    morph: Option<Provider>,
    opencode: Option<Provider>,
    #[serde(rename = "opencode-go")]
    opencode_go: Option<Provider>,
    openrouter: Option<Provider>,
    vercel: Option<Provider>,
}

#[derive(Deserialize)]
struct Provider {
    models: HashMap<String, Entry>,
}

#[derive(Deserialize)]
struct Entry {
    canonical_model_id: Option<String>,
}

struct Cache {
    index: Option<Arc<Index>>,
    refresh_at: Instant,
}

static CACHE: Mutex<Option<Cache>> = Mutex::const_new(None);

/// Leaves the routes without BYOK IDs while models.dev is unreachable and nothing is cached,
/// so Spikonado, OpenAI and ChatGPT keep working.
pub(crate) async fn resolve<'a>(routes: impl IntoIterator<Item = &'a mut ModelRoute>) {
    let Some(index) = cached_index().await else {
        return;
    };
    for route in routes {
        if let Some(ids) = route.models_dev_id.as_ref().and_then(|id| index.get(id)) {
            route.provider_model_ids = ids.clone();
        }
    }
}

async fn cached_index() -> Option<Arc<Index>> {
    let mut cache = CACHE.lock().await;
    if let Some(cache) = cache
        .as_ref()
        .filter(|cache| Instant::now() < cache.refresh_at)
    {
        return cache.index.clone();
    }
    let stale = cache.as_ref().and_then(|cache| cache.index.clone());
    let (index, refresh_after) = match fetch_index().await {
        Ok(index) => (Some(Arc::new(index)), REFRESH_AFTER),
        Err(error) => {
            eprintln!("sprocket-agent: models.dev lookup failed: {error:#}");
            (stale, RETRY_AFTER)
        }
    };
    *cache = Some(Cache {
        index: index.clone(),
        refresh_at: Instant::now() + refresh_after,
    });
    index
}

async fn fetch_index() -> anyhow::Result<Index> {
    let api: Api = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()?
        .get(API_URL)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
        .context("models.dev returned invalid JSON")?;
    Ok(index(api))
}

/// Variants such as Vercel's `-fast` share the model's models.dev ID and extend its provider
/// ID, so the shortest provider ID is the model itself.
fn index(api: Api) -> Index {
    let providers = [
        ("anthropic", api.anthropic),
        ("morph", api.morph),
        ("opencode", api.opencode),
        ("opencode-go", api.opencode_go),
        ("openrouter", api.openrouter),
        ("vercel", api.vercel),
    ];
    let mut index = Index::new();
    for (provider, models) in providers {
        for (model_id, entry) in models.into_iter().flat_map(|models| models.models) {
            let Some(canonical) = entry.canonical_model_id else {
                continue;
            };
            let ids = index.entry(canonical).or_default();
            let shorter = |current: &String| (model_id.len(), &model_id) < (current.len(), current);
            if ids.get(provider).is_none_or(shorter) {
                ids.insert(provider, model_id);
            }
        }
    }
    index
}

#[cfg(test)]
mod tests;
