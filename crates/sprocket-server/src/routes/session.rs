use axum::Json;
use axum::extract::rejection::{JsonRejection, QueryRejection};
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

/// JSON or query payload that names the user the caller claims to act as.
pub(crate) trait UserScoped {
    fn user_id(&self) -> &str;
}

pub(crate) enum AuthorizedRejection {
    Auth(ApiError),
    Json(JsonRejection),
    Query(QueryRejection),
}

impl From<ApiError> for AuthorizedRejection {
    fn from(error: ApiError) -> Self {
        Self::Auth(error)
    }
}

impl IntoResponse for AuthorizedRejection {
    fn into_response(self) -> Response {
        match self {
            Self::Auth(error) => error.into_response(),
            Self::Json(error) => error.into_response(),
            Self::Query(error) => error.into_response(),
        }
    }
}

/// JSON body whose `userId` must match the caller's session and native identity.
pub(crate) struct AuthorizedJson<T>(pub T);

impl<T> FromRequest<AppState> for AuthorizedJson<T>
where
    T: DeserializeOwned + UserScoped + Send,
{
    type Rejection = AuthorizedRejection;

    async fn from_request(req: Request, state: &AppState) -> Result<Self, Self::Rejection> {
        let headers = req.headers().clone();
        let jar = CookieJar::from_headers(&headers);
        let Json(payload) = Json::<T>::from_request(req, state)
            .await
            .map_err(AuthorizedRejection::Json)?;
        state
            .require_session_user(&headers, &jar, payload.user_id())
            .await?;
        Ok(Self(payload))
    }
}

/// Query string whose `userId` must match the caller's session and native identity.
pub(crate) struct AuthorizedQuery<T>(pub T);

impl<T> FromRequestParts<AppState> for AuthorizedQuery<T>
where
    T: DeserializeOwned + UserScoped + Send,
{
    type Rejection = AuthorizedRejection;

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
        let Query(query) = Query::<T>::from_request_parts(parts, state)
            .await
            .map_err(AuthorizedRejection::Query)?;
        state
            .require_session_user(&headers, &jar, query.user_id())
            .await?;
        Ok(Self(query))
    }
}

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::http::{Request, StatusCode, header};
    use axum::routing::post;
    use serde::Deserialize;
    use tower::ServiceExt;
    use uuid::Uuid;

    use super::*;
    use crate::auth;
    use crate::package_update::PackageUpdateManager;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Sample {
        user_id: String,
    }

    impl UserScoped for Sample {
        fn user_id(&self) -> &str {
            &self.user_id
        }
    }

    async fn echo(AuthorizedJson(payload): AuthorizedJson<Sample>) -> Json<String> {
        Json(payload.user_id)
    }

    async fn test_state(native_user: Option<&str>) -> (AppState, String) {
        let temp_dir =
            std::env::temp_dir().join(format!("sprocket-session-user-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let auth = auth::AuthState::load(&temp_dir).expect("auth state");
        let (_, session_token) = auth
            .bootstrap_browser_session(true)
            .await
            .expect("bootstrap");
        auth.bind_session_user(&session_token, "user-a")
            .await
            .unwrap();
        let native_auth = crate::native_auth::NativeAuthManager::configured_for_test(
            crate::native_auth::NativeAuthConfig {
                workos_client_id: "client_test".to_string(),
            },
            auth::desktop_login_callback_url(7731),
        );
        if let Some(user_id) = native_user {
            native_auth.authenticate_for_test(user_id).await;
        }
        let state = AppState::for_test(
            auth,
            native_auth,
            temp_dir,
            true,
            PackageUpdateManager::disabled(),
        );
        (state, session_token)
    }

    fn router(state: AppState) -> Router {
        Router::new().route("/echo", post(echo)).with_state(state)
    }

    fn echo_request(session_token: Option<&str>, body: &'static str) -> Request<Body> {
        let mut request = Request::builder()
            .method("POST")
            .uri("/echo")
            .header(header::HOST, "127.0.0.1:7731")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(session_token) = session_token {
            request = request.header(
                header::COOKIE,
                format!("{}={session_token}", crate::SESSION_COOKIE_NAME),
            );
        }
        request.body(Body::from(body)).unwrap()
    }

    #[tokio::test]
    async fn authorized_json_requires_session_native_identity_and_matching_user() {
        let (state, session_token) = test_state(Some("user-a")).await;
        let app = router(state);

        let unauthenticated = app
            .clone()
            .oneshot(echo_request(None, r#"{"userId":"user-a"}"#))
            .await
            .unwrap();
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

        let mismatched = app
            .clone()
            .oneshot(echo_request(Some(&session_token), r#"{"userId":"user-b"}"#))
            .await
            .unwrap();
        assert_eq!(mismatched.status(), StatusCode::UNAUTHORIZED);

        let ok = app
            .oneshot(echo_request(Some(&session_token), r#"{"userId":"user-a"}"#))
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::OK);
        let body = axum::body::to_bytes(ok.into_body(), usize::MAX)
            .await
            .expect("body");
        assert_eq!(body.as_ref(), br#""user-a""#);
    }

    #[tokio::test]
    async fn authorized_json_rejects_a_session_without_native_identity() {
        let (state, session_token) = test_state(None).await;
        let response = router(state)
            .oneshot(echo_request(Some(&session_token), r#"{"userId":"user-a"}"#))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn authorized_json_keeps_axum_json_rejection_for_bad_bodies() {
        let (state, session_token) = test_state(Some("user-a")).await;
        let response = router(state)
            .oneshot(echo_request(Some(&session_token), "not-json"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
