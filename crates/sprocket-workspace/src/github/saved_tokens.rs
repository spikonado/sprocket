use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Host → token, as saved in Settings → Version Control.
pub type SavedTokens = BTreeMap<String, String>;

pub type LoadFuture = Pin<Box<dyn Future<Output = anyhow::Result<SavedTokens>> + Send>>;

/// Fetches one user's saved tokens. The host installs it, since the tokens live
/// in WorkOS Vault behind Convex and reading them needs the user's token.
pub type Loader = Arc<dyn Fn(String) -> LoadFuture + Send + Sync>;

const FRESH_FOR: Duration = Duration::from_secs(5 * 60);
const RETRY_AFTER: Duration = Duration::from_secs(30);
const LOAD_TIMEOUT: Duration = Duration::from_secs(15);

static LOADER: OnceLock<Loader> = OnceLock::new();

static CACHE: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<Entry>>>>> =
    LazyLock::new(Default::default);

#[derive(Default)]
struct Entry {
    tokens: SavedTokens,
    error: Option<String>,
    next_load: Option<Instant>,
}

pub fn install(loader: Loader) {
    let _ = LOADER.set(loader);
}

pub(super) struct Loaded {
    pub tokens: SavedTokens,
    /// Why the last load failed; `tokens` are then the last ones known.
    pub error: Option<String>,
}

/// `refresh` skips the cache, so a token saved on another machine shows up now.
pub(super) async fn load(user_id: &str, refresh: bool) -> Loaded {
    let Some(loader) = LOADER.get() else {
        return Loaded {
            tokens: SavedTokens::new(),
            error: None,
        };
    };
    let entry = Arc::clone(
        CACHE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(user_id.to_string())
            .or_default(),
    );
    let mut entry = entry.lock().await;
    if refresh || entry.next_load.is_none_or(|next| next <= Instant::now()) {
        match tokio::time::timeout(LOAD_TIMEOUT, loader(user_id.to_string())).await {
            Ok(Ok(tokens)) => {
                entry.tokens = tokens;
                entry.error = None;
                entry.next_load = Some(Instant::now() + FRESH_FOR);
            }
            failed => {
                entry.error = Some(match failed {
                    Ok(Err(error)) => format!("{error:#}"),
                    _ => "Sprocket didn't answer in time.".to_string(),
                });
                entry.next_load = Some(Instant::now() + RETRY_AFTER);
            }
        }
    }
    Loaded {
        tokens: entry.tokens.clone(),
        error: entry.error.clone(),
    }
}
