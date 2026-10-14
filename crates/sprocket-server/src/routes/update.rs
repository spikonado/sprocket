use axum::Json;
use axum::extract::{FromRequestParts, State};
use axum::http::{HeaderMap, StatusCode, request::Parts};
use axum::response::Response;
use axum::routing::{get, post};

use crate::AppState;
use crate::auth::cookie_request_is_csrf_safe;
use crate::package_update::PackageUpdateSnapshot;
use crate::routes::api_error::{ApiError, no_store};
use crate::routes::session::MachineSession;

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/update", get(status))
        .route("/update/install", post(install))
}

async fn status(
    State(state): State<AppState>,
    MachineSession: MachineSession,
) -> Result<Response, ApiError> {
    Ok(update_response(state.package_updates.status().await))
}

async fn install(
    State(state): State<AppState>,
    UpdateSession: UpdateSession,
) -> Result<Response, ApiError> {
    Ok(update_response(state.package_updates.install().await))
}

struct UpdateSession;

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

fn update_response(snapshot: PackageUpdateSnapshot) -> Response {
    no_store(Json(snapshot))
}

#[cfg(test)]
mod tests;

#[cfg(all(test, unix))]
mod process_tests;
