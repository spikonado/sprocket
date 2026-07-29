use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub(crate) fn with_status(status: StatusCode, error: anyhow::Error) -> Self {
        Self {
            status,
            message: error.to_string(),
        }
    }

    pub(crate) fn unauthorized(error: anyhow::Error) -> Self {
        Self::with_status(StatusCode::UNAUTHORIZED, error)
    }

    pub(crate) fn authentication_required() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: "authentication required".to_string(),
        }
    }

    pub(crate) fn bad_request(error: anyhow::Error) -> Self {
        Self::with_status(StatusCode::BAD_REQUEST, error)
    }

    pub(crate) fn internal(error: anyhow::Error) -> Self {
        Self::with_status(StatusCode::INTERNAL_SERVER_ERROR, error)
    }

    pub(crate) fn internal_with(context: &str, error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: format!("{context}: {error:#}"),
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
