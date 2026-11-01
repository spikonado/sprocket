use axum::Json;
use axum::extract::{FromRequestParts, State};
use axum::http::{HeaderMap, StatusCode, request::Parts};
use axum::response::Response;
use axum::routing::post;

use crate::AppState;
use crate::auth::cookie_request_is_csrf_safe;
use crate::routes::api_error::{ApiError, no_store};
use crate::routes::session::MachineSession;

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/update/install", post(install))
        .route("/update/restart", post(restart))
}

async fn install(
    State(state): State<AppState>,
    UpdateSession: UpdateSession,
) -> Result<Response, ApiError> {
    Ok(no_store(Json(state.host.package_updates.install().await)))
}

struct UpdateSession;

async fn restart(
    State(state): State<AppState>,
    UpdateSession: UpdateSession,
) -> Result<StatusCode, ApiError> {
    state
        .host
        .package_updates
        .prepare_restart()
        .await
        .map_err(|error| ApiError::with_status(StatusCode::CONFLICT, error))?;
    state
        .host
        .lifetime
        .request_restart()
        .map_err(|error| ApiError::with_status(StatusCode::CONFLICT, error))?;
    Ok(StatusCode::NO_CONTENT)
}

impl FromRequestParts<AppState> for UpdateSession {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        MachineSession::from_request_parts(parts, state).await?;
        let headers = HeaderMap::from_request_parts(parts, state)
            .await
            .map_err(|_| ApiError::authentication_required())?;
        if !cookie_request_is_csrf_safe(&headers) {
            return Err(ApiError::with_status(
                StatusCode::FORBIDDEN,
                anyhow::anyhow!("package updates require a same-origin request"),
            ));
        }
        Ok(Self)
    }
}

#[cfg(test)]
mod tests;

#[cfg(all(test, unix))]
mod process_tests;
