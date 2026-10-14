use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Context, anyhow};
use futures::future::BoxFuture;
use rig::completion::Message;
use rig::message::{
    AssistantContent, AssistantMessage, CallId, Origin, Reasoning, Text, ToolCall, ToolFunction,
    ToolName, ToolResult, ToolResultContent, UserContent,
};
use serde::{Deserialize, Serialize};
use sprocket_convex::{AuthTokenFetcher, deserialize_convex_u64};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CompletionProvider {
    #[default]
    Spikonado,
    Openai,
    Chatgpt,
}

impl CompletionProvider {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Spikonado => "spikonado",
            Self::Openai => "openai",
            Self::Chatgpt => "chatgpt",
        }
    }
}

pub(crate) fn gateway_api_v1_url(gateway_url: &str) -> String {
    format!("{}/api/v1", gateway_url.trim_end_matches('/'))
}

#[derive(Clone)]
pub struct ChatGptAccess {
    pub connection_id: String,
    pub access_token: String,
    pub expires_at: u64,
}

/// The user-scoped local ChatGPT credential service handle supplied with a run.
pub trait ChatGptCredentials: Send + Sync {
    /// Session generation, not the saved-account selector ID. Switches and reconnects must change it.
    fn connection(&self) -> tokio::sync::watch::Receiver<Option<String>>;

    /// Expiry uses Unix milliseconds.
    fn credential(&self) -> BoxFuture<'_, anyhow::Result<ChatGptAccess>>;
}

#[derive(Clone)]
pub struct RunAgentRequest {
    /// Local ChatGPT credential service handle. Required for ChatGPT runs.
    pub chatgpt_credentials: Option<Arc<dyn ChatGptCredentials>>,
    pub allow_interaction: bool,
    pub cancellation: sprocket_workspace::WorkspaceCancellation,
    pub deployment_url: String,
    pub auth_token_fetcher: AuthTokenFetcher,
    pub execution_secret: String,
    pub submission_id: String,
    pub thread_id: String,
    pub repository_key: Option<String>,
    pub prompt: String,
    pub storage_ids: Vec<String>,
    pub selected_model: String,
    pub completion_provider: CompletionProvider,
    pub reasoning_effort: String,
    pub fast_mode: bool,
    pub workspace_path: String,
    pub installation_id: String,
    pub continuation_of_run_id: Option<String>,
    /// Server-owned native subagent launch service. The HTTP executor installs
    /// it; without it the delegation tools fail closed.
    pub subagent_launcher: Option<crate::subagents::SharedSubagentLauncher>,
    /// Transcript store backing local monitor reads for descendant threads.
    pub transcript_store: Option<Arc<crate::TranscriptStore>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRunResponse {
    pub created: bool,
    pub run_id: String,
    pub thread_id: String,
    pub user_id: String,
    #[serde(default)]
    pub prompt_part: Option<serde_json::Value>,
    pub gateway_url: String,
    #[serde(deserialize_with = "deserialize_convex_u64")]
    pub protocol_version: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayCredential {
    pub token: String,
    #[serde(deserialize_with = "deserialize_convex_u64")]
    pub expires_at: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiCredential {
    pub api_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunResponse {
    pub claimed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenewClaimResponse {
    pub renewed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunContextResponse {
    pub run: RunSnapshot,
    pub prompt: String,
    #[serde(default, deserialize_with = "deserialize_convex_u64")]
    pub context_tokens: u64,
    #[serde(default)]
    pub provider_handoff: Option<ProviderHandoff>,
    /// Absent until the thread first calls set_cwd.
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHandoff {
    pub completion_provider: CompletionProvider,
    pub selected_model: String,
    pub reasoning_effort: String,
    pub fast_mode: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudget {
    #[serde(deserialize_with = "deserialize_convex_u64")]
    pub context_window_tokens: u64,
    #[serde(
        rename = "autoCompactTokenLimit",
        deserialize_with = "deserialize_convex_u64"
    )]
    pub auto_handoff_token_limit: u64,
}

/// Live catalog fields for the selected model. Fetched once with the budget.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogModelCapabilities {
    pub label: String,
    pub vendor: String,
    pub context_budget: ContextBudget,
    pub supports_images: bool,
    pub supports_required_tool_choice: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHistoryMessage {
    pub role: AgentHistoryRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    pub contents: Vec<AgentHistoryContent>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentHistoryRole {
    System,
    User,
    Assistant,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentHistoryContent {
    Text {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        native_item: Option<serde_json::Value>,
    },
    Reasoning {
        summary: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        native_item: Option<serde_json::Value>,
    },
    ToolCall {
        call_id: String,
        name: String,
        arguments: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        native_item: Option<serde_json::Value>,
    },
    ToolResult {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        items: Vec<AgentHistoryToolResultItem>,
    },
    Image {
        image_json: String,
    },
    Audio {
        audio_json: String,
    },
    Video {
        video_json: String,
    },
    Document {
        document_json: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentHistoryToolResultItem {
    Text { text: String },
    Image { image_json: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    #[serde(rename = "_id")]
    pub id: String,
    pub thread_id: String,
    pub user_id: String,
    pub selected_model: String,
    #[serde(default)]
    pub completion_provider: CompletionProvider,
    pub reasoning_effort: String,
    pub fast_mode: bool,
    #[serde(deserialize_with = "deserialize_convex_u64")]
    pub started_at: u64,
    #[serde(default)]
    pub continuation_of_run_id: Option<String>,
    /// Immediate parent thread when this run's thread is a subagent. Drives
    /// payment-tool exclusion and child question availability; absent for
    /// roots and for threads recorded before the hierarchy existed.
    #[serde(default)]
    pub parent_thread_id: Option<String>,
}

fn require_non_empty<T>(items: Vec<T>, what: &str) -> anyhow::Result<Vec<T>> {
    if items.is_empty() {
        Err(anyhow!("{what} cannot be empty"))
    } else {
        Ok(items)
    }
}

fn from_json_string<T: for<'de> Deserialize<'de>>(value: &str, what: &str) -> anyhow::Result<T> {
    serde_json::from_str(value).with_context(|| format!("failed to deserialize {what}"))
}

fn with_native_item(
    block: AssistantContent,
    native_item: Option<serde_json::Value>,
) -> AssistantContent {
    match native_item {
        Some(item) => block.with_native(item),
        None => block,
    }
}

#[derive(Clone)]
struct IndexedToolCall {
    name: ToolName,
    call: CallId,
}

impl AgentHistoryContent {
    fn into_user_content(
        self,
        tool_calls: &HashMap<String, IndexedToolCall>,
    ) -> anyhow::Result<UserContent> {
        match self {
            Self::Text { text, .. } => Ok(UserContent::Text(Text::new(text))),
            Self::ToolResult { id, call_id, items } => {
                let indexed = tool_calls
                    .get(&id)
                    .or_else(|| call_id.as_ref().and_then(|call| tool_calls.get(call)))
                    .ok_or_else(|| anyhow!("history tool result has no matching call: {id}"))?;
                Ok(UserContent::ToolResult(ToolResult {
                    call: indexed.call.clone(),
                    name: indexed.name.clone(),
                    is_error: false,
                    content: require_non_empty(
                        items
                            .into_iter()
                            .map(AgentHistoryToolResultItem::into_tool_result_content)
                            .collect::<anyhow::Result<Vec<_>>>()?,
                        "tool result items",
                    )?,
                }))
            }
            Self::Image { image_json } => Ok(UserContent::Image(from_json_string(
                &image_json,
                "history image",
            )?)),
            Self::Audio { audio_json } => Ok(UserContent::Audio(from_json_string(
                &audio_json,
                "history audio",
            )?)),
            Self::Video { video_json } => Ok(UserContent::Video(from_json_string(
                &video_json,
                "history video",
            )?)),
            Self::Document { document_json } => Ok(UserContent::Document(from_json_string(
                &document_json,
                "history document",
            )?)),
            Self::Reasoning { .. } | Self::ToolCall { .. } => Err(anyhow!(
                "assistant-only history content cannot be converted into user content"
            )),
        }
    }

    fn into_assistant_content(
        self,
        tool_calls: &HashMap<String, IndexedToolCall>,
    ) -> anyhow::Result<AssistantContent> {
        match self {
            Self::Text { text, native_item } => Ok(with_native_item(
                AssistantContent::Text(Text::new(text)),
                native_item,
            )),
            Self::Reasoning {
                summary,
                native_item,
            } => Ok(with_native_item(
                AssistantContent::Reasoning(Reasoning::new(summary)),
                native_item,
            )),
            Self::ToolCall {
                call_id,
                arguments,
                native_item,
                ..
            } => {
                let indexed = tool_calls
                    .get(&call_id)
                    .ok_or_else(|| anyhow!("history tool call is not indexed: {call_id}"))?;
                let call = ToolCall::new(
                    indexed.call.clone(),
                    ToolFunction::new(indexed.name.clone(), arguments),
                );
                Ok(with_native_item(
                    AssistantContent::ToolCall(call),
                    native_item,
                ))
            }
            Self::Image { image_json } => Ok(AssistantContent::Image(from_json_string(
                &image_json,
                "assistant image",
            )?)),
            Self::ToolResult { .. }
            | Self::Audio { .. }
            | Self::Video { .. }
            | Self::Document { .. } => Err(anyhow!(
                "non-assistant history content cannot be converted into assistant content"
            )),
        }
    }
}

impl AgentHistoryToolResultItem {
    fn into_tool_result_content(self) -> anyhow::Result<ToolResultContent> {
        match self {
            Self::Text { text } => Ok(ToolResultContent::Text(Text::new(text))),
            Self::Image { image_json } => Ok(ToolResultContent::Image(from_json_string(
                &image_json,
                "tool result image",
            )?)),
        }
    }
}

fn history_message(
    message: AgentHistoryMessage,
    tool_calls: &HashMap<String, IndexedToolCall>,
) -> anyhow::Result<Message> {
    match message.role {
        AgentHistoryRole::System => {
            let text = message
                .contents
                .into_iter()
                .find_map(|content| match content {
                    AgentHistoryContent::Text { text, .. } => Some(text),
                    _ => None,
                })
                .ok_or_else(|| anyhow!("system history message is missing text content"))?;
            Ok(Message::System { content: text })
        }
        AgentHistoryRole::User => Ok(Message::User {
            content: require_non_empty(
                message
                    .contents
                    .into_iter()
                    .map(|content| content.into_user_content(tool_calls))
                    .collect::<anyhow::Result<Vec<_>>>()?,
                "user history contents",
            )?,
        }),
        AgentHistoryRole::Assistant => Ok(Message::Assistant(
            AssistantMessage::new(require_non_empty(
                message
                    .contents
                    .into_iter()
                    .map(|content| content.into_assistant_content(tool_calls))
                    .collect::<anyhow::Result<Vec<_>>>()?,
                "assistant history contents",
            )?)
            .with_origin(message.origin),
        )),
    }
}

pub(crate) fn deserialize_agent_history(
    history: Vec<AgentHistoryMessage>,
) -> anyhow::Result<Vec<Message>> {
    let mut tool_calls = HashMap::new();
    history
        .into_iter()
        .map(|message| {
            for content in &message.contents {
                if let AgentHistoryContent::ToolCall { call_id, name, .. } = content {
                    tool_calls.insert(
                        call_id.clone(),
                        IndexedToolCall {
                            name: ToolName::new(name.clone())?,
                            call: CallId::from_wire(call_id.clone()),
                        },
                    );
                }
            }
            history_message(message, &tool_calls)
        })
        .collect()
}

/// Call only for legacy history whose provenance is unavailable. Known origins,
/// including a previous model's origin, must never be replaced by the selected model.
pub(crate) fn assign_unidentified_legacy_history_origin(history: &mut [Message], origin: &Origin) {
    for message in history {
        if let Message::Assistant(assistant) = message
            && assistant.origin.is_none()
            && assistant.content.iter().all(|block| match block {
                AssistantContent::Text(_)
                | AssistantContent::ToolCall(_)
                | AssistantContent::Reasoning(_) => block.native_item().is_none_or(|item| {
                    matches!(
                        item.get("type").and_then(serde_json::Value::as_str),
                        Some("message" | "function_call" | "reasoning")
                    )
                }),
                _ => false,
            })
        {
            assistant.origin = Some(origin.clone());
        }
    }
}

#[cfg(test)]
mod tests;
