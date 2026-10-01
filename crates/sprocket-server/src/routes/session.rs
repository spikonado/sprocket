use axum::extract::FromRequestParts;
use axum::http::{HeaderMap, request::Parts};
use axum_extra::extract::CookieJar;

use crate::AppState;
use crate::auth::require_session;
use crate::routes::api_error::ApiError;

/// Request extractor proving the caller holds a session that may access this
/// machine, from either a bearer token or the session cookie.
pub(crate) struct MachineSession;

impl FromRequestParts<AppState> for MachineSession {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let headers = HeaderMap::from_request_parts(parts, state)
            .await
            .map_err(|_| ApiError::authentication_required())?;
        let jar = CookieJar::from_request_parts(parts, state)
            .await
            .map_err(|_| ApiError::authentication_required())?;
        require_session(&state.auth, &headers, &jar)
            .await
            .map_err(|_| ApiError::authentication_required())?;
        Ok(Self)
    }
}
