use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Html;
use axum::routing::{get, post};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::AppState;
use crate::auth::{BrowserConnection, browser_connection, require_bootstrap_session};
use crate::routes::api_error::ApiError;

const CALLBACK_PORT: u16 = 1455;
const LOGIN_LIFETIME: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
pub(crate) struct PendingLogins(Mutex<LoginState>);

#[derive(Default)]
struct LoginState {
    attempts: HashMap<String, PendingLogin>,
    listener: Option<tokio::task::JoinHandle<std::io::Result<()>>>,
    generation: u64,
}

impl LoginState {
    async fn stop_if_idle(&mut self) {
        if self.attempts.is_empty()
            && let Some(task) = self.listener.take()
        {
            task.abort();
            let _ = task.await;
        }
    }
}

struct PendingLogin {
    session: String,
    expires: Instant,
    result: Option<Result<String, String>>,
}

#[derive(Serialize)]
struct StartedLogin {
    state: String,
}

#[derive(Deserialize)]
struct LoginRequest {
    state: String,
}

#[derive(Deserialize)]
struct CallbackQuery {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum LoginResult {
    Pending,
    Connected { code: String },
    Failed { error: String },
}

pub(crate) fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/chatgpt/browser/start", post(start))
        .route("/chatgpt/browser/result", post(result))
        .route("/chatgpt/browser/cancel", post(cancel))
}

async fn bind_callback(
    pending: Arc<PendingLogins>,
) -> std::io::Result<tokio::task::JoinHandle<std::io::Result<()>>> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", CALLBACK_PORT)).await?;
    let router = axum::Router::new()
        .route("/auth/callback", get(callback))
        .with_state(pending);
    Ok(tokio::spawn(axum::serve(listener, router).into_future()))
}

pub(crate) async fn shutdown(pending: &PendingLogins) {
    let mut logins = pending.0.lock().await;
    logins.attempts.clear();
    logins.stop_if_idle().await;
}

async fn expire_logins(pending: Arc<PendingLogins>, generation: u64) {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let mut logins = pending.0.lock().await;
        if logins.generation != generation {
            return;
        }
        logins
            .attempts
            .retain(|_, login| login.expires > Instant::now());
        if logins.attempts.is_empty() {
            logins.stop_if_idle().await;
            return;
        }
    }
}

async fn local_session(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    jar: &CookieJar,
) -> Result<String, ApiError> {
    if browser_connection(headers, peer) != Some(BrowserConnection::Loopback) {
        return Err(ApiError::authentication_required());
    }
    let session = require_bootstrap_session(&state.auth, headers, jar)
        .await
        .map_err(|_| ApiError::authentication_required())?;
    if !state.auth.session_is_local_browser(&session).await {
        return Err(ApiError::authentication_required());
    }
    Ok(session)
}

async fn start(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<Json<StartedLogin>, ApiError> {
    let session = local_session(&state, peer, &headers, &jar).await?;
    let pending = &state.chatgpt_oauth;
    let value = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let mut logins = pending.0.lock().await;
    logins
        .attempts
        .retain(|_, login| login.expires > Instant::now());
    if logins
        .listener
        .as_ref()
        .is_some_and(|task| task.is_finished())
    {
        logins.listener.take();
    }
    if logins.listener.is_none() {
        logins.listener = Some(bind_callback(Arc::clone(pending)).await.map_err(|_| {
            ApiError::with_status(
                StatusCode::SERVICE_UNAVAILABLE,
                anyhow::anyhow!(
                    "ChatGPT browser sign-in needs port 1455. Close the app using it and retry."
                ),
            )
        })?);
        logins.generation = logins.generation.wrapping_add(1);
        tokio::spawn(expire_logins(Arc::clone(pending), logins.generation));
    }
    logins.attempts.retain(|_, login| login.session != session);
    logins.attempts.insert(
        value.clone(),
        PendingLogin {
            session,
            expires: Instant::now() + LOGIN_LIFETIME,
            result: None,
        },
    );
    Ok(Json(StartedLogin { state: value }))
}

async fn result(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<LoginRequest>,
) -> Result<Json<LoginResult>, ApiError> {
    let session = local_session(&state, peer, &headers, &jar).await?;
    let pending = &state.chatgpt_oauth;
    let mut logins = pending.0.lock().await;
    let login = logins
        .attempts
        .get_mut(&request.state)
        .ok_or_else(ApiError::authentication_required)?;
    if login.session != session {
        return Err(ApiError::authentication_required());
    }
    if login.expires <= Instant::now() {
        logins.attempts.remove(&request.state);
        logins.stop_if_idle().await;
        return Err(ApiError::authentication_required());
    }
    let Some(outcome) = login.result.take() else {
        return Ok(Json(LoginResult::Pending));
    };
    let completed = match outcome {
        Ok(code) => LoginResult::Connected { code },
        Err(error) => LoginResult::Failed { error },
    };
    logins.attempts.remove(&request.state);
    logins.stop_if_idle().await;
    Ok(Json(completed))
}

async fn cancel(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<LoginRequest>,
) -> Result<StatusCode, ApiError> {
    let session = local_session(&state, peer, &headers, &jar).await?;
    let mut logins = state.chatgpt_oauth.0.lock().await;
    if logins
        .attempts
        .get(&request.state)
        .is_some_and(|login| login.session == session)
    {
        logins.attempts.remove(&request.state);
        logins.stop_if_idle().await;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn callback(
    State(pending): State<Arc<PendingLogins>>,
    Query(query): Query<CallbackQuery>,
) -> (
    StatusCode,
    [(header::HeaderName, &'static str); 2],
    Html<&'static str>,
) {
    let headers = [
        (header::CACHE_CONTROL, "no-store"),
        (header::REFERRER_POLICY, "no-referrer"),
    ];
    let Some(state) = query.state else {
        return (
            StatusCode::BAD_REQUEST,
            headers,
            Html("Invalid ChatGPT sign-in."),
        );
    };
    let mut logins = pending.0.lock().await;
    let Some(login) = logins.attempts.get_mut(&state) else {
        return (
            StatusCode::BAD_REQUEST,
            headers,
            Html("ChatGPT sign-in expired or was cancelled."),
        );
    };
    if login.expires <= Instant::now() || login.result.is_some() {
        return (
            StatusCode::BAD_REQUEST,
            headers,
            Html("ChatGPT sign-in expired or was already completed."),
        );
    }
    login.result = Some(match (query.code, query.error) {
        (Some(code), None) if !code.is_empty() && code.len() <= 4096 => Ok(code),
        _ => Err("ChatGPT sign-in was cancelled or failed.".to_string()),
    });
    (
        StatusCode::OK,
        headers,
        Html("ChatGPT sign-in received. Return to Sprocket to finish connecting."),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn callback_accepts_only_one_valid_pending_state() {
        let pending = Arc::new(PendingLogins::default());
        let state = "a".repeat(64);
        pending.0.lock().await.attempts.insert(
            state.clone(),
            PendingLogin {
                session: "owner".into(),
                expires: Instant::now() + LOGIN_LIFETIME,
                result: None,
            },
        );

        let (status, _, _) = callback(
            State(Arc::clone(&pending)),
            Query(CallbackQuery {
                state: Some("unknown".into()),
                code: Some("stolen".into()),
                error: None,
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let valid = CallbackQuery {
            state: Some(state.clone()),
            code: Some("authorization-code".into()),
            error: None,
        };
        let (status, _, _) = callback(State(Arc::clone(&pending)), Query(valid)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            pending.0.lock().await.attempts.get(&state).unwrap().result,
            Some(Ok("authorization-code".into()))
        );

        let (status, _, _) = callback(
            State(Arc::clone(&pending)),
            Query(CallbackQuery {
                state: Some(state),
                code: Some("replacement".into()),
                error: None,
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}
