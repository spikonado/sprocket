use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, anyhow};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum_extra::extract::CookieJar;
use serde::Deserialize;
use sprocket_agent::{
    AuthTokenFetcher, RunAgentRequest, authenticated_user_id, finalize_failed_start, run_agent,
    start_agent_run,
};
use tokio::sync::{Mutex, watch};
use tokio::time::{sleep, timeout};
use uuid::Uuid;

use crate::AppState;
use crate::auth::require_session;

const AGENT_TOKEN_TOMBSTONE_TTL: Duration = Duration::from_secs(2 * 60);
const AGENT_START_TIMEOUT: Duration = Duration::from_secs(20);
const AGENT_START_CLEANUP_TIMEOUT: Duration = Duration::from_secs(6);
const AGENT_TOKEN_VERIFY_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunAgentApiRequest {
    auth_session_id: String,
    auth_token: String,
    submission_id: String,
    thread_id: String,
    prompt: String,
    selected_model: String,
    reasoning_effort: String,
    workspace_session_id: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RunAgentStartResponse {
    run_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshAgentTokenRequest {
    auth_token: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum AgentTokenStatus {
    RefreshRequired,
    Complete,
    NotFound,
}

#[derive(Clone, Default)]
pub(crate) struct AgentTokenStore {
    entries: Arc<Mutex<HashMap<String, Arc<AgentTokenEntry>>>>,
}

struct AgentTokenEntry {
    state: watch::Sender<AgentTokenState>,
}

#[derive(Clone)]
struct AgentTokenState {
    token: String,
    user_id: Option<String>,
    version: u64,
    refresh_requested: bool,
    closed: bool,
}

impl AgentTokenStore {
    async fn create(&self, id: &str, token: String) -> anyhow::Result<Arc<AgentTokenEntry>> {
        if token.trim().is_empty() {
            return Err(anyhow!("agent auth token is empty"));
        }

        let mut entries = self.entries.lock().await;
        if entries.contains_key(id) {
            return Err(anyhow!("agent auth session already exists"));
        }

        let (state, _) = watch::channel(AgentTokenState {
            token,
            user_id: None,
            version: 0,
            refresh_requested: false,
            closed: false,
        });
        let entry = Arc::new(AgentTokenEntry { state });
        entries.insert(id.to_string(), entry.clone());
        Ok(entry)
    }

    async fn get(&self, id: &str) -> Option<Arc<AgentTokenEntry>> {
        self.entries.lock().await.get(id).cloned()
    }

    async fn close(&self, id: &str, entry: &Arc<AgentTokenEntry>) {
        entry.state.send_modify(|state| {
            state.closed = true;
        });

        let store = self.clone();
        let id = id.to_string();
        let entry = entry.clone();
        tokio::spawn(async move {
            sleep(AGENT_TOKEN_TOMBSTONE_TTL).await;
            store.remove_closed(&id, &entry).await;
        });
    }

    async fn remove_closed(&self, id: &str, entry: &Arc<AgentTokenEntry>) {
        let mut entries = self.entries.lock().await;
        if entries
            .get(id)
            .is_some_and(|stored| Arc::ptr_eq(stored, entry) && stored.state.borrow().closed)
        {
            entries.remove(id);
        }
    }
}

impl AgentTokenEntry {
    fn fetcher(self: &Arc<Self>) -> AuthTokenFetcher {
        let entry = self.clone();
        Arc::new(move |force_refresh| {
            let entry = entry.clone();
            Box::pin(async move { entry.fetch(force_refresh).await })
        })
    }

    fn nonrefreshing_fetcher(self: &Arc<Self>) -> AuthTokenFetcher {
        let entry = self.clone();
        Arc::new(move |_| {
            let entry = entry.clone();
            Box::pin(async move { entry.current_token() })
        })
    }

    fn current_token(&self) -> anyhow::Result<String> {
        let state = self.state.borrow();
        if state.closed {
            return Err(anyhow!("agent auth session is closed"));
        }
        Ok(state.token.clone())
    }

    fn bind_user(&self, user_id: &str) -> anyhow::Result<()> {
        let user_id = user_id.trim();
        if user_id.is_empty() {
            return Err(anyhow!("agent auth user ID is empty"));
        }
        let mut result = Ok(());
        self.state
            .send_modify(|state| match state.user_id.as_deref() {
                Some(existing_user_id) if existing_user_id != user_id => {
                    result = Err(anyhow!("agent auth session belongs to a different user"));
                }
                Some(_) => {}
                None => state.user_id = Some(user_id.to_string()),
            });
        result
    }

    fn require_user(&self, user_id: &str) -> anyhow::Result<()> {
        if self.state.borrow().user_id.as_deref() == Some(user_id) {
            Ok(())
        } else {
            Err(anyhow!("agent auth session belongs to a different user"))
        }
    }

    async fn fetch(&self, force_refresh: bool) -> anyhow::Result<String> {
        let mut state_updates = self.state.subscribe();
        let version = {
            let state = state_updates.borrow();
            if state.closed {
                return Err(anyhow!("agent auth session is closed"));
            }
            if !force_refresh {
                return Ok(state.token.clone());
            }
            state.version
        };
        self.state.send_modify(|state| {
            state.refresh_requested = true;
        });

        timeout(Duration::from_secs(60), async {
            loop {
                state_updates
                    .changed()
                    .await
                    .context("agent auth session is closed")?;
                {
                    let state = state_updates.borrow();
                    if state.closed {
                        return Err(anyhow!("agent auth session is closed"));
                    }
                    if state.version > version {
                        return Ok(state.token.clone());
                    }
                }
            }
        })
        .await
        .context("timed out waiting for the browser to refresh agent authentication")?
    }

    async fn wait_for_refresh(&self) -> AgentTokenStatus {
        let mut state_updates = self.state.subscribe();
        loop {
            {
                let state = state_updates.borrow();
                if state.closed {
                    return AgentTokenStatus::Complete;
                }
                if state.refresh_requested {
                    return AgentTokenStatus::RefreshRequired;
                }
            }
            if state_updates.changed().await.is_err() {
                return AgentTokenStatus::Complete;
            }
        }
    }

    async fn update(&self, token: String) -> anyhow::Result<()> {
        if token.trim().is_empty() {
            return Err(anyhow!("agent auth token is empty"));
        }

        if self.state.borrow().closed {
            return Err(anyhow!("agent auth session is closed"));
        }
        self.state.send_modify(|state| {
            state.token = token;
            state.version += 1;
            state.refresh_requested = false;
        });
        Ok(())
    }
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/agent/run", post(run_agent_handler))
        .route(
            "/agent/auth/{auth_session_id}",
            get(wait_for_agent_token_handler).put(refresh_agent_token_handler),
        )
}

async fn run_agent_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<RunAgentApiRequest>,
) -> Result<(StatusCode, Json<RunAgentStartResponse>), ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;

    let workspace_path = state
        .workspace_sessions
        .workspace_path(&payload.workspace_session_id)
        .await
        .map_err(ApiError::bad_request)?;

    let auth_session_id = Uuid::parse_str(payload.auth_session_id.trim())
        .map_err(|_| ApiError::bad_request(anyhow!("invalid agent auth session ID")))?
        .to_string();
    let token_entry = state
        .agent_tokens
        .create(&auth_session_id, payload.auth_token)
        .await
        .map_err(ApiError::bad_request)?;

    let request = RunAgentRequest {
        deployment_url: state.convex_deployment_url.clone(),
        auth_token_fetcher: token_entry.fetcher(),
        submission_id: payload.submission_id,
        thread_id: payload.thread_id,
        prompt: payload.prompt,
        selected_model: payload.selected_model,
        reasoning_effort: payload.reasoning_effort,
        workspace_path,
    };

    let cleanup_request = request.clone();
    let cleanup_token_entry = token_entry.clone();
    let run = match await_agent_start(
        start_agent_run(request),
        AGENT_START_TIMEOUT,
        AGENT_START_CLEANUP_TIMEOUT,
        move |startup_error| {
            let mut cleanup_request = cleanup_request;
            cleanup_request.auth_token_fetcher = cleanup_token_entry.nonrefreshing_fetcher();
            finalize_failed_start(cleanup_request, startup_error)
        },
        &state.agent_tokens,
        &auth_session_id,
        &token_entry,
    )
    .await
    {
        Ok(run) => {
            if let Err(error) = token_entry.bind_user(run.user_id()) {
                state
                    .agent_tokens
                    .close(&auth_session_id, &token_entry)
                    .await;
                return Err(ApiError::internal(error));
            }
            run
        }
        Err(error) => return Err(ApiError::internal(error)),
    };
    let run_id = run.run_id().to_string();
    let token_store = state.agent_tokens.clone();

    tokio::spawn(async move {
        if let Err(error) = run_agent(run).await {
            eprintln!("sprocket-server: agent run failed: {error:#}");
        }
        token_store.close(&auth_session_id, &token_entry).await;
    });

    Ok((StatusCode::ACCEPTED, Json(RunAgentStartResponse { run_id })))
}

async fn await_agent_start<F, T, C, CF>(
    startup: F,
    startup_timeout: Duration,
    cleanup_timeout: Duration,
    cleanup: C,
    token_store: &AgentTokenStore,
    auth_session_id: &str,
    token_entry: &Arc<AgentTokenEntry>,
) -> anyhow::Result<T>
where
    F: Future<Output = anyhow::Result<T>>,
    C: FnOnce(String) -> CF,
    CF: Future<Output = anyhow::Result<()>>,
{
    let result = timeout(startup_timeout, startup)
        .await
        .context("timed out starting agent run")
        .and_then(|result| result);

    match result {
        Ok(started) => Ok(started),
        Err(error) => {
            let startup_error = format!("{error:#}");
            let cleanup_result = timeout(cleanup_timeout, cleanup(startup_error.clone())).await;
            token_store.close(auth_session_id, token_entry).await;
            match cleanup_result {
                Ok(Ok(())) => Err(error),
                Ok(Err(cleanup_error)) => Err(anyhow!(
                    "{startup_error}; additionally failed to reconcile the startup: {cleanup_error:#}"
                )),
                Err(_) => Err(anyhow!(
                    "{startup_error}; additionally timed out reconciling the startup"
                )),
            }
        }
    }
}

async fn wait_for_agent_token_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Path(auth_session_id): Path<String>,
) -> Result<Json<AgentTokenStatus>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;

    Ok(Json(match state.agent_tokens.get(&auth_session_id).await {
        Some(entry) => entry.wait_for_refresh().await,
        None => AgentTokenStatus::NotFound,
    }))
}

async fn refresh_agent_token_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Path(auth_session_id): Path<String>,
    Json(payload): Json<RefreshAgentTokenRequest>,
) -> Result<StatusCode, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;

    let Some(entry) = state.agent_tokens.get(&auth_session_id).await else {
        return Err(ApiError::not_found(anyhow!(
            "agent auth session was not found"
        )));
    };
    let verified_user_id = timeout(
        AGENT_TOKEN_VERIFY_TIMEOUT,
        authenticated_user_id(&state.convex_deployment_url, payload.auth_token.clone()),
    )
    .await
    .context("timed out verifying refreshed agent authentication")
    .and_then(|result| result)
    .map_err(ApiError::unauthorized)?;
    entry
        .require_user(&verified_user_id)
        .map_err(ApiError::forbidden)?;
    entry
        .update(payload.auth_token)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn unauthorized(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: error.to_string(),
        }
    }

    fn bad_request(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: error.to_string(),
        }
    }

    fn internal(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: format!("failed to start agent run: {error:#}"),
        }
    }

    fn forbidden(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: error.to_string(),
        }
    }

    fn not_found(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: error.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    struct DropSignal(Arc<AtomicBool>);

    impl Drop for DropSignal {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn forced_fetch_waits_for_a_browser_refresh() {
        let store = AgentTokenStore::default();
        let entry = store
            .create("auth-session", "token-1".to_string())
            .await
            .expect("create token session");
        let fetcher = entry.fetcher();

        assert_eq!(fetcher(false).await.expect("initial token"), "token-1");

        let refresh = tokio::spawn(async move { fetcher(true).await });
        assert!(matches!(
            entry.wait_for_refresh().await,
            AgentTokenStatus::RefreshRequired
        ));
        entry
            .update("token-2".to_string())
            .await
            .expect("update token");

        assert_eq!(
            refresh
                .await
                .expect("refresh task")
                .expect("refreshed token"),
            "token-2"
        );
    }

    #[tokio::test]
    async fn refreshed_tokens_must_match_the_verified_run_user() {
        let store = AgentTokenStore::default();
        let entry = store
            .create("auth-session", "token-1".to_string())
            .await
            .expect("create token session");

        entry.bind_user("user-a").expect("bind verified user");

        entry.require_user("user-a").expect("matching user");
        assert!(entry.require_user("user-b").is_err());
        assert_eq!(entry.current_token().expect("current token"), "token-1");
    }

    #[tokio::test]
    async fn cleanup_fetcher_never_waits_for_an_interactive_refresh() {
        let store = AgentTokenStore::default();
        let entry = store
            .create("auth-session", "token-1".to_string())
            .await
            .expect("create token session");
        let interactive_fetcher = entry.fetcher();
        let refresh = tokio::spawn(async move { interactive_fetcher(true).await });
        assert!(matches!(
            entry.wait_for_refresh().await,
            AgentTokenStatus::RefreshRequired
        ));

        let cleanup_fetcher = entry.nonrefreshing_fetcher();
        let cleanup_token = timeout(Duration::from_millis(20), cleanup_fetcher(true))
            .await
            .expect("cleanup token fetch must be noninteractive")
            .expect("cleanup token");

        assert_eq!(cleanup_token, "token-1");
        refresh.abort();
    }

    #[tokio::test]
    async fn closed_sessions_remain_as_complete_tombstones() {
        let store = AgentTokenStore::default();
        let entry = store
            .create("auth-session", "token-1".to_string())
            .await
            .expect("create token session");

        store.close("auth-session", &entry).await;

        let tombstone = store.get("auth-session").await.expect("stored tombstone");
        assert!(matches!(
            tombstone.wait_for_refresh().await,
            AgentTokenStatus::Complete
        ));
    }

    #[tokio::test]
    async fn timed_out_startup_reconciles_before_closing_its_token_session() {
        let store = AgentTokenStore::default();
        let entry = store
            .create("auth-session", "token-1".to_string())
            .await
            .expect("create token session");
        let dropped = Arc::new(AtomicBool::new(false));
        let drop_signal = DropSignal(dropped.clone());
        let startup = async move {
            let _drop_signal = drop_signal;
            std::future::pending::<anyhow::Result<()>>().await
        };
        let reconciled = Arc::new(AtomicBool::new(false));
        let cleanup_reconciled = reconciled.clone();
        let cleanup_entry = entry.clone();

        let error = await_agent_start(
            startup,
            Duration::from_millis(1),
            Duration::from_secs(1),
            move |_| async move {
                assert!(!cleanup_entry.state.borrow().closed);
                cleanup_reconciled.store(true, Ordering::SeqCst);
                Ok(())
            },
            &store,
            "auth-session",
            &entry,
        )
        .await
        .expect_err("startup should time out");

        assert!(error.to_string().contains("timed out starting agent run"));
        assert!(dropped.load(Ordering::SeqCst));
        assert!(reconciled.load(Ordering::SeqCst));
        assert!(matches!(
            entry.wait_for_refresh().await,
            AgentTokenStatus::Complete
        ));
    }
}
