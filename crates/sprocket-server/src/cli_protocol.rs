pub use crate::native_auth::{NativeLoginStatus as LoginStatus, NativeUser};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliDiscovery {
    pub instance_id: String,
    pub http_base_url: String,
    pub proof: Vec<u8>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliBootstrapRequest {
    pub client: CliConnectRequest,
    pub session_token: String,
    pub proof: Vec<u8>,
}

#[derive(Deserialize, Serialize)]
pub struct CliBootstrapResponse {
    pub proof: Vec<u8>,
}

pub fn cli_bootstrap_response_message(
    instance_id: &str,
    url: &str,
    request: &CliBootstrapRequest,
) -> String {
    serde_json::json!([
        "sprocket-cli-bootstrap-accepted-v1",
        instance_id,
        url,
        request.client,
        request.session_token
    ])
    .to_string()
}

pub fn cli_discovery_message(challenge: &str, instance_id: &str, url: &str) -> String {
    serde_json::json!(["sprocket-cli-discovery-v1", challenge, instance_id, url]).to_string()
}

pub fn cli_bootstrap_message(
    instance_id: &str,
    url: &str,
    request: &CliBootstrapRequest,
) -> String {
    serde_json::json!([
        "sprocket-cli-bootstrap-v1",
        instance_id,
        url,
        request.client,
        request.session_token
    ])
    .to_string()
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq, clap::ValueEnum)]
#[serde(rename_all = "camelCase")]
pub enum CredentialStore {
    #[default]
    Keyring,
    File,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliConnectRequest {
    pub client_id: String,
    pub client_version: String,
    pub deployment_url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliClientRequest {
    pub client_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliLoginRequest {
    pub client_id: String,
    pub credential_store: Option<CredentialStore>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLoginResponse {
    pub verification_uri: String,
    pub user_code: String,
    pub expires_in: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliRunRequest {
    pub client_id: String,
    pub prompt: String,
    pub directory: String,
    pub thread_id: Option<String>,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub fast: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliModel {
    pub id: String,
    pub label: String,
    pub reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliModelsResponse {
    pub default_model_id: String,
    pub models: Vec<CliModel>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStarted {
    pub run_id: String,
    pub thread_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliOutputRequest {
    pub client_id: String,
    pub after_part: i64,
    pub after_revision: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRunSnapshot {
    pub revision: u64,
    pub answer: String,
    pub run_id: String,
    pub thread_id: String,
    pub status: String,
    pub error: Option<String>,
    pub parts: Vec<sprocket_agent::TranscriptPart>,
    pub has_more: bool,
    pub execution_finished: bool,
    pub live: Option<sprocket_agent::LiveCompletionOverlay>,
}
