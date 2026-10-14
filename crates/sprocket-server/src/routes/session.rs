use axum::Json;
use axum::extract::{FromRequest, FromRequestParts, Query, Request};
use axum::http::{HeaderMap, request::Parts};
use axum::response::{IntoResponse, Response};
use axum_extra::extract::CookieJar;
use serde::de::DeserializeOwned;

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

pub(crate) trait UserScoped {
    fn user_id(&self) -> &str;
}

pub(crate) struct AuthorizedJson<T>(pub T);

impl<T> FromRequest<AppState> for AuthorizedJson<T>
where
    T: DeserializeOwned + UserScoped + Send,
{
    type Rejection = Response;

    async fn from_request(req: Request, state: &AppState) -> Result<Self, Self::Rejection> {
        let headers = req.headers().clone();
        let jar = CookieJar::from_headers(&headers);
        let Json(payload) = Json::<T>::from_request(req, state)
            .await
            .map_err(IntoResponse::into_response)?;
        state
            .require_session_user(&headers, &jar, payload.user_id())
            .await
            .map_err(IntoResponse::into_response)?;
        Ok(Self(payload))
    }
}

pub(crate) struct AuthorizedQuery<T>(pub T);

impl<T> FromRequestParts<AppState> for AuthorizedQuery<T>
where
    T: DeserializeOwned + UserScoped + Send,
{
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let jar = CookieJar::from_headers(&parts.headers);
        let Query(query) = Query::<T>::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        state
            .require_session_user(&parts.headers, &jar, query.user_id())
            .await
            .map_err(IntoResponse::into_response)?;
        Ok(Self(query))
    }
}

#[cfg(test)]
mod tests;
