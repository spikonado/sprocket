use serde::{Deserialize, Deserializer, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RunAgentRequest {
    pub deployment_url: String,
    pub auth_token: Option<String>,
    pub guest_id: Option<String>,
    pub run_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessageSnapshot {
    pub role: String,
    pub status: String,
    pub text: String,
    #[serde(deserialize_with = "deserialize_convex_u64")]
    pub order: u64,
    #[serde(deserialize_with = "deserialize_convex_u64")]
    pub step_order: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunContextResponse {
    pub run: RunSnapshot,
    pub thread_record: ThreadRecordSnapshot,
    pub workspace_session: WorkspaceSessionSnapshot,
    pub messages: Vec<ThreadMessageSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    #[serde(rename = "_id")]
    pub id: String,
    pub thread_id: String,
    pub workspace_session_id: String,
    pub selected_model: String,
    pub reasoning_effort: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRecordSnapshot {
    pub thread_id: String,
    pub workspace_path: String,
    pub title: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessionSnapshot {
    #[serde(rename = "_id")]
    pub id: String,
    pub workspace_path: String,
    pub workspace_name: String,
}

pub(crate) fn deserialize_convex_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = f64::deserialize(deserializer)?;
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 {
        return Err(serde::de::Error::custom(format!(
            "expected a non-negative integer-compatible Convex number, got {value}"
        )));
    }

    Ok(value as u64)
}
