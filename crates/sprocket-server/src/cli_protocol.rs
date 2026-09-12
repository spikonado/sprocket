pub use crate::native_auth::{NativeLoginStatus as LoginStatus, NativeUser};
use serde::{Deserialize, Serialize};

pub const CLI_PROTOCOL_VERSION: u32 = 1;

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
    pub protocol_version: u32,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStarted {
    pub run_id: String,
    pub thread_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliPollRequest {
    pub client_id: String,
    pub after_part: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRunSnapshot {
    pub run_id: String,
    pub thread_id: String,
    pub status: String,
    pub error: Option<String>,
    pub parts: Vec<sprocket_agent::TranscriptPart>,
    pub has_more: bool,
    pub execution_finished: bool,
    pub live: Option<sprocket_agent::LiveCompletionOverlay>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliResult {
    pub submission_id: Option<String>,
    pub termination_reason: Option<String>,
    pub run_id: Option<String>,
    pub thread_id: Option<String>,
    pub status: String,
    pub answer: String,
    pub error: Option<String>,
}
