use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum_extra::extract::CookieJar;

use crate::AppState;
use crate::auth::{
    AuthSessionResponse, AuthState, BootstrapRequest, BootstrapResponse, LocalIdentityResponse,
    extract_session_token, require_session,
};

const DESKTOP_BOOTSTRAP_TOKEN_HEADER: &str = "x-sprocket-desktop-bootstrap-token";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBootstrapResponse {
    http_base_url: String,
    pairing_credential: String,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/auth/session", get(session))
        .route("/auth/bootstrap", post(bootstrap))
        .route("/auth/desktop-bootstrap", get(desktop_bootstrap))
        .route("/auth/local-identity", get(local_identity))
}

async fn session(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Json<AuthSessionResponse> {
    let token = extract_session_token(&headers, &jar);
    Json(state.auth.session_state(token.as_deref()).await)
}

async fn bootstrap(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(payload): Json<BootstrapRequest>,
) -> Result<(StatusCode, CookieJar, Json<BootstrapResponse>), ApiError> {
    let (response, session_token) = state
        .auth
        .bootstrap(&payload.credential)
        .await
        .map_err(ApiError::bad_request)?;

    let cookie = AuthState::make_session_cookie(&session_token);
    let mut jar = jar;
    jar = jar.add(cookie);

    Ok((StatusCode::OK, jar, Json(response)))
}

async fn local_identity(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<Json<LocalIdentityResponse>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(|_| ApiError::unauthorized())?;

    let identity = state
        .auth
        .local_identity()
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(identity))
}

async fn desktop_bootstrap(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DesktopBootstrapResponse>, ApiError> {
    let Some(desktop_bootstrap_token) = &state.desktop_bootstrap_token else {
        return Err(ApiError::unauthorized());
    };
    let Some(provided_token) = headers
        .get(DESKTOP_BOOTSTRAP_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err(ApiError::unauthorized());
    };

    let mut expected_token = desktop_bootstrap_token.lock().await;
    if expected_token.as_deref() != Some(provided_token) {
        return Err(ApiError::unauthorized());
    }
    *expected_token = None;

    Ok(desktop_bootstrap_response(&state))
}

fn desktop_bootstrap_response(state: &AppState) -> Json<DesktopBootstrapResponse> {
    Json(DesktopBootstrapResponse {
        http_base_url: state.http_base_url.clone(),
        pairing_credential: state.auth.pairing_credential().to_string(),
    })
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: error.to_string(),
        }
    }

    fn unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: "authentication required".to_string(),
        }
    }

    fn internal(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
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
