use std::collections::BTreeMap;

use axum::Json;
use axum::routing::get;
use serde::Serialize;

use crate::AppState;
use crate::repo_env::repo_env_vars;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigResponse {
    env: BTreeMap<String, String>,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new().route("/config", get(config))
}

async fn config() -> Json<ConfigResponse> {
    Json(ConfigResponse {
        env: repo_env_vars(),
    })
}
