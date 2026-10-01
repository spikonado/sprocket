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
use crate::auth::{
    AuthState, BrowserConnection, browser_connection, cookie_request_is_csrf_safe,
    require_session_user,
};
use crate::chatgpt_credentials::{ChatGptService, ServiceStatus};
use crate::routes::api_error::ApiError;

const LOGIN_LIFETIME: Duration = Duration::from_secs(5 * 60);

pub(crate) struct PendingLogins {
    logins: Mutex<LoginState>,
    service: Arc<ChatGptService>,
    auth: Arc<AuthState>,
}

impl PendingLogins {
    pub(crate) fn new(service: Arc<ChatGptService>, auth: Arc<AuthState>) -> Arc<Self> {
        Arc::new(Self {
            logins: Mutex::new(LoginState::default()),
            service,
            auth,
        })
    }
}

#[derive(Default)]
struct LoginState {
    attempts: HashMap<String, PendingLogin>,
    listener: Option<tokio::task::JoinHandle<std::io::Result<()>>>,
    redirect_uri: String,
    generation: u64,
}

impl LoginState {
    fn stop_if_idle(&mut self) {
        if self.attempts.is_empty()
            && let Some(task) = self.listener.take()
        {
            task.abort();
        }
    }
}

#[derive(Clone)]
struct PendingLogin {
    session: String,
    user: String,
    connection: Option<String>,
    expires: Instant,
    nonce: String,
    verifier: String,
    redirect_uri: String,
    processing: bool,
    result: Option<Result<(), String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedLogin {
    state: String,
    authorize_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserRequest {
    user_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartRequest {
    user_id: String,
    connection_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginRequest {
    user_id: String,
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectionRequest {
    user_id: String,
    connection_id: String,
}

#[derive(Deserialize)]
struct CallbackQuery {
    state: Option<String>,
    code: Option<String>,
    client_id: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum LoginResult {
    Pending,
    Complete,
    Error { error: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderStatus {
    #[serde(flatten)]
    status: ServiceStatus,
    login_available: bool,
}

#[derive(Serialize)]
struct Disconnected {
    warning: Option<String>,
}

pub(crate) fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/chatgpt/status", post(status))
        .route("/chatgpt/browser/start", post(start))
        .route("/chatgpt/browser/result", post(result))
        .route("/chatgpt/browser/cancel", post(cancel))
        .route("/chatgpt/select", post(select))
        .route("/chatgpt/disconnect", post(disconnect))
        .layer(axum::middleware::map_response(
            |mut response: axum::response::Response| async move {
                response.headers_mut().insert(
                    header::CACHE_CONTROL,
                    axum::http::HeaderValue::from_static("no-store"),
                );
                response
            },
        ))
}

async fn bind_callback(
    pending: Arc<PendingLogins>,
) -> std::io::Result<(String, tokio::task::JoinHandle<std::io::Result<()>>)> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let redirect_uri = format!(
        "http://127.0.0.1:{}/auth/callback",
        listener.local_addr()?.port()
    );
    let router = axum::Router::new()
        .route("/auth/callback", get(callback))
        .with_state(pending);
    Ok((
        redirect_uri,
        tokio::spawn(axum::serve(listener, router).into_future()),
    ))
}

pub(crate) async fn shutdown(pending: &PendingLogins) {
    let mut logins = pending.logins.lock().await;
    logins.attempts.clear();
    logins.stop_if_idle();
}

async fn expire_logins(pending: Arc<PendingLogins>, generation: u64) {
    loop {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let mut logins = pending.logins.lock().await;
        if logins.generation != generation {
            return;
        }
        logins
            .attempts
            .retain(|_, login| login.expires > Instant::now());
        if logins.attempts.is_empty() {
            logins.stop_if_idle();
            return;
        }
    }
}

async fn session_user(
    state: &AppState,
    headers: &HeaderMap,
    jar: &CookieJar,
    user: &str,
) -> Result<String, ApiError> {
    if !cookie_request_is_csrf_safe(headers) {
        return Err(ApiError::authentication_required());
    }
    require_session_user(&state.auth, headers, jar, user)
        .await
        .map_err(|_| ApiError::authentication_required())
}

async fn local_session(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    jar: &CookieJar,
    user: &str,
) -> Result<String, ApiError> {
    if !state.loopback_desktop_login_supported
        || browser_connection(headers, peer) != Some(BrowserConnection::Loopback)
    {
        return Err(ApiError::bad_request(anyhow::anyhow!(
            "ChatGPT sign-in requires Sprocket running on your own computer. Open its local settings."
        )));
    }
    let session = session_user(state, headers, jar, user).await?;
    if !state.auth.session_is_local_browser(&session).await {
        return Err(ApiError::authentication_required());
    }
    Ok(session)
}

fn secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

async fn start(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<StartRequest>,
) -> Result<Json<StartedLogin>, ApiError> {
    let session = local_session(&state, peer, &headers, &jar, &request.user_id).await?;
    let pending = &state.chatgpt_oauth;
    let value = secret();
    let nonce = secret();
    let verifier = secret();
    let mut logins = pending.logins.lock().await;
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
        let (redirect_uri, listener) = bind_callback(Arc::clone(pending)).await.map_err(|_| {
            ApiError::with_status(
                StatusCode::SERVICE_UNAVAILABLE,
                anyhow::anyhow!("Could not open the local ChatGPT callback listener."),
            )
        })?;
        logins.redirect_uri = redirect_uri;
        logins.listener = Some(listener);
        logins.generation = logins.generation.wrapping_add(1);
        tokio::spawn(expire_logins(Arc::clone(pending), logins.generation));
    }
    let redirect_uri = logins.redirect_uri.clone();
    let authorize_url = state
        .chatgpt_credentials
        .authorization(
            &request.user_id,
            request.connection_id.as_deref(),
            &redirect_uri,
            &value,
            &nonce,
            &verifier,
        )
        .await
        .map_err(ApiError::bad_request)?;
    logins
        .attempts
        .retain(|_, login| login.user != request.user_id);
    if logins.attempts.len() >= 64 {
        return Err(ApiError::bad_request(anyhow::anyhow!(
            "Too many pending sign-ins. Retry later."
        )));
    }
    logins.attempts.insert(
        value.clone(),
        PendingLogin {
            session,
            user: request.user_id,
            connection: request.connection_id,
            expires: Instant::now() + LOGIN_LIFETIME,
            nonce,
            verifier,
            redirect_uri,
            processing: false,
            result: None,
        },
    );
    Ok(Json(StartedLogin {
        state: value,
        authorize_url,
    }))
}

async fn result(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<LoginRequest>,
) -> Result<Json<LoginResult>, ApiError> {
    let session = local_session(&state, peer, &headers, &jar, &request.user_id).await?;
    let logins = state.chatgpt_oauth.logins.lock().await;
    let login = logins
        .attempts
        .get(&request.state)
        .filter(|login| {
            login.session == session
                && login.user == request.user_id
                && login.expires > Instant::now()
        })
        .ok_or_else(ApiError::authentication_required)?;
    Ok(Json(match &login.result {
        None => LoginResult::Pending,
        Some(Ok(())) => LoginResult::Complete,
        Some(Err(error)) => LoginResult::Error {
            error: error.clone(),
        },
    }))
}

async fn cancel(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<LoginRequest>,
) -> Result<Json<()>, ApiError> {
    let session = local_session(&state, peer, &headers, &jar, &request.user_id).await?;
    let mut logins = state.chatgpt_oauth.logins.lock().await;
    if logins
        .attempts
        .get(&request.state)
        .is_some_and(|login| login.session == session && login.user == request.user_id)
    {
        logins.attempts.remove(&request.state);
        logins.stop_if_idle();
    }
    Ok(Json(()))
}

async fn status(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<UserRequest>,
) -> Result<Json<ProviderStatus>, ApiError> {
    let session = session_user(&state, &headers, &jar, &request.user_id).await?;
    let login_available = state.loopback_desktop_login_supported
        && browser_connection(&headers, peer) == Some(BrowserConnection::Loopback)
        && state.auth.session_is_local_browser(&session).await;
    Ok(Json(ProviderStatus {
        status: state
            .chatgpt_credentials
            .status(&request.user_id)
            .await
            .map_err(ApiError::bad_request)?,
        login_available,
    }))
}

async fn select(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<ConnectionRequest>,
) -> Result<Json<()>, ApiError> {
    session_user(&state, &headers, &jar, &request.user_id).await?;
    let mut logins = state.chatgpt_oauth.logins.lock().await;
    logins
        .attempts
        .retain(|_, login| login.user != request.user_id);
    logins.stop_if_idle();
    drop(logins);
    state
        .chatgpt_credentials
        .select(&request.user_id, &request.connection_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(()))
}

async fn disconnect(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<ConnectionRequest>,
) -> Result<Json<Disconnected>, ApiError> {
    session_user(&state, &headers, &jar, &request.user_id).await?;
    let pending = Arc::clone(&state.chatgpt_oauth);
    let service = Arc::clone(&state.chatgpt_credentials);
    let warning = tokio::spawn(async move {
        let mut logins = pending.logins.lock().await;
        logins
            .attempts
            .retain(|_, login| login.user != request.user_id);
        logins.stop_if_idle();
        drop(logins);
        service
            .disconnect(&request.user_id, &request.connection_id)
            .await
    })
    .await
    .map_err(|_| ApiError::internal(anyhow::anyhow!("Sign-out task stopped.")))?
    .map_err(ApiError::bad_request)?;
    Ok(Json(Disconnected { warning }))
}

async fn finish_callback(
    pending: Arc<PendingLogins>,
    state: String,
    login: PendingLogin,
    query: CallbackQuery,
) {
    let outcome = match (query.code, query.error) {
        (Some(code), None) if !code.is_empty() && code.len() <= 4096 => {
            pending
                .service
                .exchange(
                    &login.user,
                    login.connection.as_deref(),
                    &login.redirect_uri,
                    &login.nonce,
                    &login.verifier,
                    &code,
                    query.client_id.as_deref(),
                )
                .await
        }
        _ => Err(anyhow::anyhow!("ChatGPT sign-in was cancelled or failed.")),
    };
    let mut logins = pending.logins.lock().await;
    let session_guard = pending
        .auth
        .lock_session_user(&login.session, &login.user)
        .await;
    let valid = logins.attempts.get(&state).is_some_and(|current| {
        current.session == login.session
            && current.user == login.user
            && current.expires > Instant::now()
    }) && session_guard.is_ok();
    if !valid {
        drop(session_guard);
        drop(logins);
        if let Ok(grant) = outcome {
            pending.service.discard(grant).await;
        }
        return;
    }
    let result = match outcome {
        Ok(grant) => pending.service.commit(&login.user, grant).await,
        Err(error) => Err(error),
    };
    drop(session_guard);
    if let Some(current) = logins.attempts.get_mut(&state) {
        current.result = Some(result.map_err(|error| error.to_string()));
        current.verifier.clear();
        current.nonce.clear();
    }
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
    let Some(state) = query.state.clone() else {
        return (
            StatusCode::BAD_REQUEST,
            headers,
            Html("Invalid ChatGPT sign-in."),
        );
    };
    let mut logins = pending.logins.lock().await;
    let Some(login) = logins.attempts.get_mut(&state) else {
        return (
            StatusCode::BAD_REQUEST,
            headers,
            Html("ChatGPT sign-in expired or was cancelled."),
        );
    };
    if login.expires <= Instant::now() || login.processing || login.result.is_some() {
        return (
            StatusCode::BAD_REQUEST,
            headers,
            Html("ChatGPT sign-in expired or was already completed."),
        );
    }
    login.processing = true;
    let login = login.clone();
    drop(logins);
    tokio::spawn(finish_callback(pending, state, login, query));
    (
        StatusCode::OK,
        headers,
        Html("ChatGPT sign-in received. Return to Sprocket to check the connection."),
    )
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    use super::*;

    async fn fixture() -> (tempfile::TempDir, AppState, String) {
        let directory = tempfile::tempdir().unwrap();
        let auth = AuthState::load(directory.path()).unwrap();
        let (_, session) = auth.bootstrap_browser_session(true).await.unwrap();
        auth.bind_session_user(&session, "user-a").await.unwrap();
        let native_auth = crate::native_auth::NativeAuthManager::new(
            "https://example.convex.cloud".into(),
            "http://127.0.0.1:7731/auth/callback".into(),
            directory.path(),
            Arc::clone(&auth),
        );
        let state = AppState::for_test(
            auth,
            native_auth,
            directory.path().to_owned(),
            true,
            crate::package_update::PackageUpdateManager::from_env(),
        );
        (directory, state, session)
    }

    fn request(path: &str, session: &str, user: &str) -> Request<Body> {
        let mut request = Request::builder()
            .method("POST")
            .uri(path)
            .header(header::HOST, "127.0.0.1:7731")
            .header(header::ORIGIN, "http://127.0.0.1:7731")
            .header(
                header::COOKIE,
                format!("{}={session}", crate::SESSION_COOKIE_NAME),
            )
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::json!({"userId":user}).to_string()))
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo("127.0.0.1:1234".parse::<SocketAddr>().unwrap()));
        request
    }

    #[tokio::test]
    async fn local_status_is_account_scoped_and_reports_login_availability() {
        let (_directory, state, session) = fixture().await;
        let app = crate::build_router(state, None);
        let response = app
            .clone()
            .oneshot(request("/api/chatgpt/status", &session, "user-a"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 65536)
            .await
            .unwrap();
        let status: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            status,
            serde_json::json!({
                "accounts":[], "activeConnectionId":null, "models":[], "loginAvailable":true
            })
        );
        let response = app
            .oneshot(request("/api/chatgpt/status", &session, "user-b"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn callback_records_failure_once_without_exposing_oauth_material() {
        let (_directory, state, session) = fixture().await;
        let pending = state.chatgpt_oauth;
        let value = secret();
        pending.logins.lock().await.attempts.insert(
            value.clone(),
            PendingLogin {
                session,
                user: "user-a".into(),
                connection: None,
                expires: Instant::now() + LOGIN_LIFETIME,
                nonce: secret(),
                verifier: secret(),
                redirect_uri: "http://127.0.0.1:1234/auth/callback".into(),
                processing: false,
                result: None,
            },
        );
        let query = || CallbackQuery {
            state: Some(value.clone()),
            code: None,
            client_id: None,
            error: Some("access_denied".into()),
        };
        let (status, headers, _) = callback(State(Arc::clone(&pending)), Query(query())).await;
        assert_eq!(status, StatusCode::OK);
        assert!(headers.contains(&(header::CACHE_CONTROL, "no-store")));
        let (status, _, _) = callback(State(Arc::clone(&pending)), Query(query())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let logins = pending.logins.lock().await;
                let login = logins.attempts.get(&value).unwrap();
                if let Some(Err(error)) = &login.result {
                    assert_eq!(error, "ChatGPT sign-in was cancelled or failed.");
                    assert!(login.verifier.is_empty());
                    assert!(login.nonce.is_empty());
                    break;
                }
                drop(logins);
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(LoginResult::Complete).unwrap(),
            serde_json::json!({"status":"complete"})
        );
    }

    #[tokio::test]
    async fn callback_listener_uses_an_available_loopback_port() {
        let (_directory, state, _) = fixture().await;
        let (redirect_uri, listener) = bind_callback(Arc::clone(&state.chatgpt_oauth))
            .await
            .unwrap();
        let url = url::Url::parse(&redirect_uri).unwrap();
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert_eq!(url.path(), "/auth/callback");
        assert!(url.port().unwrap() > 0);
        let response = reqwest::get(redirect_uri).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        listener.abort();
        let _ = listener.await;
    }
}
