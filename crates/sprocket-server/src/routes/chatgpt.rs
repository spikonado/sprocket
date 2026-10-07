use std::net::SocketAddr;
use std::sync::Arc;

use axum::Json;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::routing::post;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::auth::{
    BrowserConnection, browser_connection, cookie_request_is_csrf_safe, require_session_user,
};
use crate::chatgpt_credentials::ServiceStatus;
use crate::chatgpt_oauth::{PendingAttempt, PendingResult, ReserveError, new_secret};
use crate::routes::api_error::ApiError;

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

async fn start(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<StartRequest>,
) -> Result<Json<StartedLogin>, ApiError> {
    let session = local_session(&state, peer, &headers, &jar, &request.user_id).await?;
    let pending = &state.chatgpt_oauth;
    let value = new_secret();
    let nonce = new_secret();
    let verifier = new_secret();
    let user_id = request.user_id;
    let connection_id = request.connection_id;
    let redirect_uri = pending
        .reserve_pending(
            value.clone(),
            PendingAttempt {
                session: session.clone(),
                user: user_id.clone(),
                connection: connection_id.clone(),
                nonce: nonce.clone(),
                verifier: verifier.clone(),
            },
        )
        .await
        .map_err(|error| match error {
            ReserveError::Listener(error) => ApiError::with_status(
                StatusCode::SERVICE_UNAVAILABLE,
                anyhow::Error::new(error)
                    .context("Could not open the local ChatGPT callback listener."),
            ),
            ReserveError::TooMany => {
                ApiError::bad_request(anyhow::anyhow!("Too many pending sign-ins. Retry later."))
            }
        })?;
    let authorize_url = match state
        .chatgpt_credentials
        .authorization(
            &user_id,
            connection_id.as_deref(),
            &redirect_uri,
            &value,
            &nonce,
            &verifier,
        )
        .await
    {
        Ok(authorize_url) => authorize_url,
        Err(error) => {
            pending.cancel_pending(&session, &user_id, &value).await;
            return Err(ApiError::bad_request(error));
        }
    };
    if !pending.commit_pending(&session, &user_id, &value).await {
        return Err(ApiError::authentication_required());
    }
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
    let login = state
        .chatgpt_oauth
        .pending_result(&session, &request.user_id, &request.state)
        .await
        .ok_or_else(ApiError::authentication_required)?;
    Ok(Json(match login {
        PendingResult::Pending => LoginResult::Pending,
        PendingResult::Complete => LoginResult::Complete,
        PendingResult::Error(error) => LoginResult::Error { error },
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
    state
        .chatgpt_oauth
        .cancel_pending(&session, &request.user_id, &request.state)
        .await;
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
    let login_available = state.chatgpt_credentials.available()
        && state.loopback_desktop_login_supported
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
    state
        .chatgpt_oauth
        .drop_user_pending(&request.user_id)
        .await;
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
    let user_id = request.user_id;
    let connection_id = request.connection_id;
    let warning = tokio::spawn(async move {
        pending.drop_user_pending(&user_id).await;
        service.disconnect(&user_id, &connection_id).await
    })
    .await
    .map_err(|_| ApiError::internal(anyhow::anyhow!("Sign-out task stopped.")))?
    .map_err(ApiError::bad_request)?;
    Ok(Json(Disconnected { warning }))
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::sync::Arc;

    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Request, StatusCode, header};
    use tower::ServiceExt;

    use super::LoginResult;
    use crate::AppState;
    use crate::auth::AuthState;

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
                "accounts":[], "activeConnectionId":null, "loginAvailable":true
            })
        );
        let response = app
            .oneshot(request("/api/chatgpt/status", &session, "user-b"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn login_result_complete_serializes_as_status() {
        assert_eq!(
            serde_json::to_value(LoginResult::Complete).unwrap(),
            serde_json::json!({"status":"complete"})
        );
    }
}
