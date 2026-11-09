use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use serde::Deserialize;
use sprocket_host::kicad_connector::ConnectorStatus;

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::routes::session::{AuthorizedJson, AuthorizedQuery, UserScoped};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserRequest {
    user_id: String,
}

impl UserScoped for UserRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/connectors", get(list))
        .route(
            "/connectors/kicad/install",
            post(start_kicad_install_or_update),
        )
        .route("/connectors/kicad/uninstall", post(uninstall_kicad))
}

async fn list(
    State(state): State<AppState>,
    AuthorizedQuery(_): AuthorizedQuery<UserRequest>,
) -> Json<Vec<ConnectorStatus>> {
    Json(vec![state.host.kicad.status().await])
}

async fn start_kicad_install_or_update(
    State(state): State<AppState>,
    AuthorizedJson(_): AuthorizedJson<UserRequest>,
) -> Json<ConnectorStatus> {
    state.host.kicad.start_install_or_update();
    Json(state.host.kicad.status().await)
}

async fn uninstall_kicad(
    State(state): State<AppState>,
    AuthorizedJson(_): AuthorizedJson<UserRequest>,
) -> Result<Json<ConnectorStatus>, ApiError> {
    state
        .host
        .kicad
        .uninstall()
        .await
        .map_err(|error| ApiError::with_status(StatusCode::CONFLICT, error))?;
    Ok(Json(state.host.kicad.status().await))
}
