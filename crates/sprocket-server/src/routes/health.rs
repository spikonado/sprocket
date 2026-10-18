use axum::Json;
use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use serde::Serialize;

use crate::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    http_base_url: String,
    version: &'static str,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new().route("/health", get(health))
}

async fn health(State(state): State<AppState>) -> Response {
    crate::routes::api_error::no_store(Json(HealthResponse {
        status: "ok",
        http_base_url: state.http_base_url.clone(),
        version: sprocket_workspace::SPROCKET_VERSION,
    }))
}
