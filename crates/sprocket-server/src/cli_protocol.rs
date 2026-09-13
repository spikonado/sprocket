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
