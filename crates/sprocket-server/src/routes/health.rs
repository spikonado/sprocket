use axum::Json;
use axum::extract::State;
use axum::routing::get;
use serde::Serialize;

use crate::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    http_base_url: String,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new().route("/health", get(health))
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        http_base_url: state.http_base_url.clone(),
    })
}
