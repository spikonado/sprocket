use axum::Json;
use axum::extract::{Path, State};
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
use sprocket_agent::services::ToolPolicy;
use sprocket_host::mcp_store::{McpConnector, NewMcpTransport};
use sprocket_host::service_hub::{self, ServerTool};

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::routes::session::{AuthorizedJson, AuthorizedQuery, UserScoped};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserRequest {
    user_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddRequest {
    user_id: String,
    name: String,
    transport: NewMcpTransport,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PolicyRequest {
    user_id: String,
    tool: String,
    policy: ToolPolicy,
}

impl UserScoped for UserRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

impl UserScoped for AddRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

impl UserScoped for PolicyRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

#[derive(Serialize)]
struct ToolsResponse {
    tools: Vec<ServerTool>,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/connectors/mcp", get(list).post(add))
        .route("/connectors/mcp/{id}/delete", post(delete))
        .route("/connectors/mcp/{id}/tools", get(tools))
        .route("/connectors/mcp/{id}/policy", post(set_policy))
}

async fn list(
    State(state): State<AppState>,
    AuthorizedQuery(_): AuthorizedQuery<UserRequest>,
) -> Result<Json<Vec<McpConnector>>, ApiError> {
    let connectors = state
        .host
        .mcp
        .run(|store| {
            Ok(store
                .list()?
                .into_iter()
                .map(|server| server.connector)
                .collect())
        })
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(connectors))
}

async fn add(
    State(state): State<AppState>,
    AuthorizedJson(payload): AuthorizedJson<AddRequest>,
) -> Result<Json<McpConnector>, ApiError> {
    let connector = state
        .host
        .mcp
        .run(move |store| store.add(&payload.name, payload.transport))
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(connector))
}

async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    AuthorizedJson(_): AuthorizedJson<UserRequest>,
) -> Result<Json<()>, ApiError> {
    state
        .host
        .mcp
        .run(move |store| store.delete(&id))
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(()))
}

async fn tools(
    State(state): State<AppState>,
    Path(id): Path<String>,
    AuthorizedQuery(_): AuthorizedQuery<UserRequest>,
) -> Result<Json<ToolsResponse>, ApiError> {
    let tools = service_hub::list_server_tools(&state.host, &id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(ToolsResponse { tools }))
}

async fn set_policy(
    State(state): State<AppState>,
    Path(id): Path<String>,
    AuthorizedJson(payload): AuthorizedJson<PolicyRequest>,
) -> Result<Json<()>, ApiError> {
    state
        .host
        .mcp
        .run(move |store| store.set_policy(&id, &payload.tool, payload.policy))
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(()))
}
