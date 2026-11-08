//! Maps a catalog model's models.dev ID to the ID each BYOK provider serves it under.

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
    checked_at: Instant,
    index: Option<Arc<Index>>,
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
    let stale = match cache.as_ref() {
        Some(cache) if cache.index.is_some() && cache.checked_at.elapsed() < REFRESH_AFTER => {
            return cache.index.clone();
        }
        Some(cache) if cache.checked_at.elapsed() < RETRY_AFTER => return cache.index.clone(),
        Some(cache) => cache.index.clone(),
        None => None,
    };
    let index = match fetch_index().await {
        Ok(index) => Some(Arc::new(index)),
        Err(error) => {
            eprintln!("sprocket-agent: models.dev lookup failed: {error:#}");
            stale
        }
    };
    *cache = Some(Cache {
        checked_at: Instant::now(),
        index: index.clone(),
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
