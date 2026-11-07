use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub type SavedTokens = BTreeMap<String, String>;

pub type LoadFuture = Pin<Box<dyn Future<Output = anyhow::Result<SavedTokens>> + Send>>;

pub type Loader = Arc<dyn Fn(String) -> LoadFuture + Send + Sync>;

const FRESH_FOR: Duration = Duration::from_secs(5 * 60);
const RETRY_AFTER: Duration = Duration::from_secs(30);
const LOAD_TIMEOUT: Duration = Duration::from_secs(15);

static LOADER: OnceLock<Loader> = OnceLock::new();

static CACHE: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<Entry>>>>> =
    LazyLock::new(Default::default);

#[derive(Default)]
struct Entry {
    tokens: Option<SavedTokens>,
    error: Option<String>,
    next_load: Option<Instant>,
}

pub fn install(loader: Loader) {
    let _ = LOADER.set(loader);
}

pub(super) struct Loaded {
    /// The last tokens known, or `None` before any load succeeded.
    pub tokens: Option<SavedTokens>,
    /// Why the last load failed.
    pub error: Option<String>,
}

pub(super) async fn load(user_id: &str) -> Loaded {
    load_or_reload(user_id, false).await
}

pub(super) async fn reload(user_id: &str) -> Loaded {
    load_or_reload(user_id, true).await
}

async fn load_or_reload(user_id: &str, reload: bool) -> Loaded {
    let Some(loader) = LOADER.get() else {
        return Loaded {
            tokens: Some(SavedTokens::new()),
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
    if reload || entry.next_load.is_none_or(|next| next <= Instant::now()) {
        match tokio::time::timeout(LOAD_TIMEOUT, loader(user_id.to_string())).await {
            Ok(Ok(tokens)) => {
                entry.tokens = Some(tokens);
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
