use anyhow::{Context, anyhow};
use rig::OneOrMany;
use rig::completion::Message;
use rig::message::{
    AssistantContent, Reasoning, ReasoningContent, Text, ToolCall, ToolFunction, ToolResult,
    ToolResultContent, UserContent,
};
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
    pub agent_history: Option<Vec<PersistedAgentHistoryMessage>>,
    pub workspace_session: WorkspaceSessionSnapshot,
    pub messages: Vec<ThreadMessageSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedAgentHistoryMessage {
    pub role: PersistedAgentHistoryRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant_id: Option<String>,
    pub contents: Vec<PersistedAgentHistoryContent>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PersistedAgentHistoryRole {
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
pub enum PersistedAgentHistoryContent {
    Text {
        text: String,
    },
    Reasoning {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        blocks_json: String,
    },
    ToolCall {
        call_id: String,
        name: String,
        arguments_json: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        additional_params_json: Option<String>,
    },
    ToolResult {
        call_id: String,
        items: Vec<PersistedAgentHistoryToolResultItem>,
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
pub enum PersistedAgentHistoryToolResultItem {
    Text { text: String },
    Image { image_json: String },
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
    pub title: Option<String>,
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
    let value = Option::<f64>::deserialize(deserializer)?;
    let Some(value) = value else {
        return Ok(0);
    };

    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 {
        return Err(serde::de::Error::custom(format!(
            "expected a non-negative integer-compatible Convex number, got {value}"
        )));
    }

    Ok(value as u64)
}

fn vec_to_one_or_many<T: Clone>(items: Vec<T>, what: &str) -> anyhow::Result<OneOrMany<T>> {
    OneOrMany::many(items).map_err(|_| anyhow!("{what} cannot be empty"))
}

fn to_json_string<T: Serialize>(value: &T, what: &str) -> anyhow::Result<String> {
    serde_json::to_string(value).with_context(|| format!("failed to serialize {what}"))
}

fn from_json_string<T: for<'de> Deserialize<'de>>(value: &str, what: &str) -> anyhow::Result<T> {
    serde_json::from_str(value).with_context(|| format!("failed to deserialize {what}"))
}

fn require_call_id(call_id: Option<String>, what: &str) -> anyhow::Result<String> {
    call_id.ok_or_else(|| anyhow!("{what} is missing call_id"))
}

impl PersistedAgentHistoryContent {
    fn from_user_content(content: UserContent) -> anyhow::Result<Self> {
        match content {
            UserContent::Text(Text { text }) => Ok(Self::Text { text }),
            UserContent::ToolResult(ToolResult {
                call_id, content, ..
            }) => Ok(Self::ToolResult {
                call_id: require_call_id(call_id, "tool result")?,
                items: content
                    .into_iter()
                    .map(PersistedAgentHistoryToolResultItem::from_tool_result_content)
                    .collect::<anyhow::Result<Vec<_>>>()?,
            }),
            UserContent::Image(image) => Ok(Self::Image {
                image_json: to_json_string(&image, "history image")?,
            }),
            UserContent::Audio(audio) => Ok(Self::Audio {
                audio_json: to_json_string(&audio, "history audio")?,
            }),
            UserContent::Video(video) => Ok(Self::Video {
                video_json: to_json_string(&video, "history video")?,
            }),
            UserContent::Document(document) => Ok(Self::Document {
                document_json: to_json_string(&document, "history document")?,
            }),
        }
    }

    fn from_assistant_content(content: AssistantContent) -> anyhow::Result<Self> {
        match content {
            AssistantContent::Text(Text { text }) => Ok(Self::Text { text }),
            AssistantContent::Reasoning(Reasoning { id, content, .. }) => Ok(Self::Reasoning {
                id,
                blocks_json: to_json_string(&content, "reasoning blocks")?,
            }),
            AssistantContent::ToolCall(ToolCall {
                call_id,
                function,
                signature,
                additional_params,
                ..
            }) => Ok(Self::ToolCall {
                call_id: require_call_id(call_id, "tool call")?,
                name: function.name,
                arguments_json: to_json_string(&function.arguments, "tool call arguments")?,
                signature,
                additional_params_json: additional_params
                    .as_ref()
                    .map(|params| to_json_string(params, "tool call additional params"))
                    .transpose()?,
            }),
            AssistantContent::Image(image) => Ok(Self::Image {
                image_json: to_json_string(&image, "assistant image")?,
            }),
        }
    }

    fn into_user_content(self) -> anyhow::Result<UserContent> {
        match self {
            Self::Text { text } => Ok(UserContent::Text(Text { text })),
            Self::ToolResult { call_id, items } => Ok(UserContent::ToolResult(ToolResult {
                id: call_id.clone(),
                call_id: Some(call_id),
                content: vec_to_one_or_many(
                    items
                        .into_iter()
                        .map(PersistedAgentHistoryToolResultItem::into_tool_result_content)
                        .collect::<anyhow::Result<Vec<_>>>()?,
                    "tool result items",
                )?,
            })),
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

    fn into_assistant_content(self) -> anyhow::Result<AssistantContent> {
        match self {
            Self::Text { text } => Ok(AssistantContent::Text(Text { text })),
            Self::Reasoning { id, blocks_json } => Ok(AssistantContent::Reasoning(
                serde_json::from_value(serde_json::json!({
                    "id": id,
                    "content": from_json_string::<Vec<ReasoningContent>>(
                    &blocks_json,
                    "reasoning blocks",
                )?,
                }))
                .context("failed to reconstruct reasoning history content")?,
            )),
            Self::ToolCall {
                call_id,
                name,
                arguments_json,
                signature,
                additional_params_json,
            } => Ok(AssistantContent::ToolCall(ToolCall {
                id: call_id.clone(),
                call_id: Some(call_id),
                function: ToolFunction {
                    name,
                    arguments: from_json_string(&arguments_json, "tool call arguments")?,
                },
                signature,
                additional_params: additional_params_json
                    .as_deref()
                    .map(|json| from_json_string(json, "tool call additional params"))
                    .transpose()?,
            })),
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

impl PersistedAgentHistoryToolResultItem {
    fn from_tool_result_content(content: ToolResultContent) -> anyhow::Result<Self> {
        match content {
            ToolResultContent::Text(Text { text }) => Ok(Self::Text { text }),
            ToolResultContent::Image(image) => Ok(Self::Image {
                image_json: to_json_string(&image, "tool result image")?,
            }),
        }
    }

    fn into_tool_result_content(self) -> anyhow::Result<ToolResultContent> {
        match self {
            Self::Text { text } => Ok(ToolResultContent::Text(Text { text })),
            Self::Image { image_json } => Ok(ToolResultContent::Image(from_json_string(
                &image_json,
                "tool result image",
            )?)),
        }
    }
}

impl TryFrom<Message> for PersistedAgentHistoryMessage {
    type Error = anyhow::Error;

    fn try_from(message: Message) -> Result<Self, Self::Error> {
        match message {
            Message::System { content } => Ok(Self {
                role: PersistedAgentHistoryRole::System,
                assistant_id: None,
                contents: vec![PersistedAgentHistoryContent::Text { text: content }],
            }),
            Message::User { content } => Ok(Self {
                role: PersistedAgentHistoryRole::User,
                assistant_id: None,
                contents: content
                    .into_iter()
                    .map(PersistedAgentHistoryContent::from_user_content)
                    .collect::<anyhow::Result<Vec<_>>>()?,
            }),
            Message::Assistant { id, content } => Ok(Self {
                role: PersistedAgentHistoryRole::Assistant,
                assistant_id: id,
                contents: content
                    .into_iter()
                    .map(PersistedAgentHistoryContent::from_assistant_content)
                    .collect::<anyhow::Result<Vec<_>>>()?,
            }),
        }
    }
}

impl TryFrom<PersistedAgentHistoryMessage> for Message {
    type Error = anyhow::Error;

    fn try_from(message: PersistedAgentHistoryMessage) -> Result<Self, Self::Error> {
        match message.role {
            PersistedAgentHistoryRole::System => {
                let text = message
                    .contents
                    .into_iter()
                    .find_map(|content| match content {
                        PersistedAgentHistoryContent::Text { text } => Some(text),
                        _ => None,
                    })
                    .ok_or_else(|| anyhow!("system history message is missing text content"))?;
                Ok(Message::System { content: text })
            }
            PersistedAgentHistoryRole::User => Ok(Message::User {
                content: vec_to_one_or_many(
                    message
                        .contents
                        .into_iter()
                        .map(PersistedAgentHistoryContent::into_user_content)
                        .collect::<anyhow::Result<Vec<_>>>()?,
                    "user history contents",
                )?,
            }),
            PersistedAgentHistoryRole::Assistant => Ok(Message::Assistant {
                id: message.assistant_id,
                content: vec_to_one_or_many(
                    message
                        .contents
                        .into_iter()
                        .map(PersistedAgentHistoryContent::into_assistant_content)
                        .collect::<anyhow::Result<Vec<_>>>()?,
                    "assistant history contents",
                )?,
            }),
        }
    }
}

pub(crate) fn serialize_agent_history(
    history: Vec<Message>,
) -> anyhow::Result<Vec<PersistedAgentHistoryMessage>> {
    history
        .into_iter()
        .map(PersistedAgentHistoryMessage::try_from)
        .collect()
}

pub(crate) fn deserialize_agent_history(
    history: Option<Vec<PersistedAgentHistoryMessage>>,
) -> anyhow::Result<Vec<Message>> {
    history
        .unwrap_or_default()
        .into_iter()
        .map(Message::try_from)
        .collect()
}

#[cfg(test)]
mod tests {
    use rig::OneOrMany;
    use rig::completion::Message;
    use rig::message::{AssistantContent, ToolResultContent, UserContent};

    use super::{
        PersistedAgentHistoryContent, PersistedAgentHistoryMessage, PersistedAgentHistoryRole,
        deserialize_agent_history, serialize_agent_history,
    };

    #[test]
    fn serializes_tool_history_with_call_id_only() {
        let history = vec![
            Message::Assistant {
                id: None,
                content: OneOrMany::many(vec![AssistantContent::tool_call_with_call_id(
                    "tool_call_1",
                    "call_1".to_string(),
                    "read_file",
                    serde_json::json!({ "path": "src/lib.rs" }),
                )])
                .expect("assistant content"),
            },
            Message::User {
                content: OneOrMany::many(vec![UserContent::tool_result_with_call_id(
                    "tool_result_1",
                    "call_1".to_string(),
                    OneOrMany::one(ToolResultContent::text("{\"ok\":true}")),
                )])
                .expect("user content"),
            },
        ];

        let persisted = serialize_agent_history(history).expect("persisted history");

        match &persisted[0].contents[0] {
            PersistedAgentHistoryContent::ToolCall { call_id, .. } => {
                assert_eq!(call_id, "call_1");
            }
            other => panic!("expected tool call, got {other:?}"),
        }

        match &persisted[1].contents[0] {
            PersistedAgentHistoryContent::ToolResult { call_id, .. } => {
                assert_eq!(call_id, "call_1");
            }
            other => panic!("expected tool result, got {other:?}"),
        }

        let json = serde_json::to_value(&persisted).expect("persisted json");
        let first = &json[0]["contents"][0];
        let second = &json[1]["contents"][0];
        assert!(first.get("id").is_none());
        assert_eq!(first["callId"], "call_1");
        assert!(second.get("id").is_none());
        assert_eq!(second["callId"], "call_1");
    }

    #[test]
    fn deserializes_tool_history_into_rig_messages_with_matching_ids() {
        let history = vec![
            PersistedAgentHistoryMessage {
                role: PersistedAgentHistoryRole::Assistant,
                assistant_id: None,
                contents: vec![PersistedAgentHistoryContent::ToolCall {
                    call_id: "call_1".to_string(),
                    name: "read_file".to_string(),
                    arguments_json: "{\"path\":\"src/lib.rs\"}".to_string(),
                    signature: None,
                    additional_params_json: None,
                }],
            },
            PersistedAgentHistoryMessage {
                role: PersistedAgentHistoryRole::User,
                assistant_id: None,
                contents: vec![PersistedAgentHistoryContent::ToolResult {
                    call_id: "call_1".to_string(),
                    items: vec![super::PersistedAgentHistoryToolResultItem::Text {
                        text: "{\"ok\":true}".to_string(),
                    }],
                }],
            },
        ];

        let messages = deserialize_agent_history(Some(history)).expect("messages");

        match &messages[0] {
            Message::Assistant { content, .. } => match content.iter().next() {
                Some(AssistantContent::ToolCall(tool_call)) => {
                    assert_eq!(tool_call.id, "call_1");
                    assert_eq!(tool_call.call_id.as_deref(), Some("call_1"));
                }
                other => panic!("expected assistant tool call, got {other:?}"),
            },
            other => panic!("expected assistant message, got {other:?}"),
        }

        match &messages[1] {
            Message::User { content } => match content.iter().next() {
                Some(UserContent::ToolResult(tool_result)) => {
                    assert_eq!(tool_result.id, "call_1");
                    assert_eq!(tool_result.call_id.as_deref(), Some("call_1"));
                }
                other => panic!("expected user tool result, got {other:?}"),
            },
            other => panic!("expected user message, got {other:?}"),
        }
    }
}
