use anyhow::{Context, anyhow};
use rig::OneOrMany;
use rig::completion::Message;
use rig::message::{
    AssistantContent, ReasoningContent, Text, ToolCall, ToolFunction, ToolResult,
    ToolResultContent, UserContent,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RunAgentRequest {
    pub deployment_url: String,
    pub auth_token: Option<String>,
    pub guest_id: Option<String>,
    pub submission_id: String,
    pub thread_id: String,
    pub prompt: String,
    pub selected_model: String,
    pub reasoning_effort: String,
    pub workspace_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRunResponse {
    pub created: bool,
    pub run_id: String,
    pub prompt_message_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunResponse {
    pub claimed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunContextResponse {
    pub run: RunSnapshot,
    pub thread_record: ThreadRecordSnapshot,
    pub prompt: String,
    pub agent_history: Vec<AgentHistoryMessage>,
    pub workspace_session: WorkspaceSessionSnapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHistoryMessage {
    pub role: AgentHistoryRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant_id: Option<String>,
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
        additional_params_json: Option<String>,
    },
    Reasoning {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        blocks_json: String,
    },
    ToolCall {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        name: String,
        arguments_json: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        additional_params_json: Option<String>,
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
    pub workspace_session_id: String,
    pub selected_model: String,
    pub reasoning_effort: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRecordSnapshot {
    #[serde(rename = "_id")]
    pub id: String,
    pub workspace_session_id: String,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessionSnapshot {
    #[serde(rename = "_id")]
    pub id: String,
    pub workspace_name: String,
}

fn vec_to_one_or_many<T: Clone>(items: Vec<T>, what: &str) -> anyhow::Result<OneOrMany<T>> {
    OneOrMany::many(items).map_err(|_| anyhow!("{what} cannot be empty"))
}

fn from_json_string<T: for<'de> Deserialize<'de>>(value: &str, what: &str) -> anyhow::Result<T> {
    serde_json::from_str(value).with_context(|| format!("failed to deserialize {what}"))
}

impl AgentHistoryContent {
    fn into_user_content(self) -> anyhow::Result<UserContent> {
        match self {
            Self::Text { text, .. } => Ok(UserContent::Text(Text::new(text))),
            Self::ToolResult { id, call_id, items } => Ok(UserContent::ToolResult(ToolResult {
                id,
                call_id,
                content: vec_to_one_or_many(
                    items
                        .into_iter()
                        .map(AgentHistoryToolResultItem::into_tool_result_content)
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
            Self::Text {
                text,
                additional_params_json,
            } => Ok(AssistantContent::Text(Text {
                text,
                additional_params: additional_params_json
                    .as_deref()
                    .map(|json| from_json_string(json, "text additional params"))
                    .transpose()?,
            })),
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
                id,
                call_id,
                name,
                arguments_json,
                signature,
                additional_params_json,
            } => Ok(AssistantContent::ToolCall(ToolCall {
                id,
                call_id,
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

impl TryFrom<AgentHistoryMessage> for Message {
    type Error = anyhow::Error;

    fn try_from(message: AgentHistoryMessage) -> Result<Self, Self::Error> {
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
                content: vec_to_one_or_many(
                    message
                        .contents
                        .into_iter()
                        .map(AgentHistoryContent::into_user_content)
                        .collect::<anyhow::Result<Vec<_>>>()?,
                    "user history contents",
                )?,
            }),
            AgentHistoryRole::Assistant => Ok(Message::Assistant {
                id: message.assistant_id,
                content: vec_to_one_or_many(
                    message
                        .contents
                        .into_iter()
                        .map(AgentHistoryContent::into_assistant_content)
                        .collect::<anyhow::Result<Vec<_>>>()?,
                    "assistant history contents",
                )?,
            }),
        }
    }
}

pub(crate) fn deserialize_agent_history(
    history: Vec<AgentHistoryMessage>,
) -> anyhow::Result<Vec<Message>> {
    history.into_iter().map(Message::try_from).collect()
}

#[cfg(test)]
mod tests {
    use rig::completion::Message;
    use rig::message::{AssistantContent, UserContent};

    use super::{
        AgentHistoryContent, AgentHistoryMessage, AgentHistoryRole, AgentHistoryToolResultItem,
        deserialize_agent_history,
    };

    #[test]
    fn deserializes_tool_history_into_rig_messages_with_matching_ids() {
        let history = vec![
            AgentHistoryMessage {
                role: AgentHistoryRole::Assistant,
                assistant_id: None,
                contents: vec![AgentHistoryContent::ToolCall {
                    id: "tool_call_1".to_string(),
                    call_id: Some("call_1".to_string()),
                    name: "exec_command".to_string(),
                    arguments_json: "{\"cmd\":\"cat src/lib.rs\"}".to_string(),
                    signature: None,
                    additional_params_json: None,
                }],
            },
            AgentHistoryMessage {
                role: AgentHistoryRole::User,
                assistant_id: None,
                contents: vec![AgentHistoryContent::ToolResult {
                    id: "tool_call_1".to_string(),
                    call_id: Some("call_1".to_string()),
                    items: vec![AgentHistoryToolResultItem::Text {
                        text: "{\"ok\":true}".to_string(),
                    }],
                }],
            },
        ];

        let messages = deserialize_agent_history(history).expect("messages");

        match &messages[0] {
            Message::Assistant { content, .. } => match content.iter().next() {
                Some(AssistantContent::ToolCall(tool_call)) => {
                    assert_eq!(tool_call.id, "tool_call_1");
                    assert_eq!(tool_call.call_id.as_deref(), Some("call_1"));
                }
                other => panic!("expected assistant tool call, got {other:?}"),
            },
            other => panic!("expected assistant message, got {other:?}"),
        }

        match &messages[1] {
            Message::User { content } => match content.iter().next() {
                Some(UserContent::ToolResult(tool_result)) => {
                    assert_eq!(tool_result.id, "tool_call_1");
                    assert_eq!(tool_result.call_id.as_deref(), Some("call_1"));
                }
                other => panic!("expected user tool result, got {other:?}"),
            },
            other => panic!("expected user message, got {other:?}"),
        }
    }

    #[test]
    fn restores_assistant_text_metadata_while_accepting_plain_user_text() {
        let history: Vec<AgentHistoryMessage> = serde_json::from_value(serde_json::json!([
            {
                "role": "user",
                "contents": [{ "type": "text", "text": "hello" }]
            },
            {
                "role": "assistant",
                "contents": [{
                    "type": "text",
                    "text": "hi",
                    "additionalParamsJson": "{\"openai\":{\"itemId\":\"msg_123\"}}"
                }]
            }
        ]))
        .expect("history wire format");

        let messages = deserialize_agent_history(history).expect("messages");

        match &messages[0] {
            Message::User { content } => match content.iter().next() {
                Some(UserContent::Text(text)) => {
                    assert_eq!(text.text, "hello");
                    assert!(text.additional_params.is_none());
                }
                other => panic!("expected user text, got {other:?}"),
            },
            other => panic!("expected user message, got {other:?}"),
        }
        match &messages[1] {
            Message::Assistant { content, .. } => match content.iter().next() {
                Some(AssistantContent::Text(text)) => {
                    assert_eq!(text.text, "hi");
                    assert_eq!(
                        text.additional_params.as_ref().unwrap()["openai"]["itemId"],
                        "msg_123"
                    );
                }
                other => panic!("expected assistant text, got {other:?}"),
            },
            other => panic!("expected assistant message, got {other:?}"),
        }
    }
}
