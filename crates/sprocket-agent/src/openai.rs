use rig::client::CompletionClient;
use rig::completion::{CompletionError, CompletionModel, CompletionRequest, CompletionResponse};
use rig::message::{AssistantContent, Message};
use rig::providers::openai;
use rig::streaming::StreamingCompletionResponse;

use crate::reasoning::opaque_reasoning_blob;

pub(crate) struct OpenAiReplayClient(pub(crate) openai::Client);

impl CompletionClient for OpenAiReplayClient {
    type CompletionModel = OpenAiReplayModel;

    fn completion_model(&self, model: impl Into<String>) -> Self::CompletionModel {
        OpenAiReplayModel(self.0.completion_model(model))
    }
}

pub(crate) struct OpenAiReplayModel(openai::responses_api::ResponsesCompletionModel);

fn replay_contents(mut request: CompletionRequest) -> CompletionRequest {
    // Rig can omit empty reasoning items and regroup a turn's output. Replay
    // our reconstructed contents, not references to OpenAI's original items.
    request.chat_history.retain_mut(|message| {
        if let Message::Assistant { id, content } = message {
            *id = None;
            content.retain(|part| match part {
                AssistantContent::Reasoning(reasoning) => {
                    opaque_reasoning_blob(reasoning).is_some()
                }
                _ => true,
            });
            for part in content.iter_mut() {
                if let AssistantContent::ToolCall(call) = part
                    && let Some(provider) = &mut call.provider
                {
                    provider.item_id = None;
                }
            }
            return !content.is_empty();
        }
        true
    });
    if let Some(params) = request
        .additional_params
        .get_or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
    {
        params.insert("store".to_string(), serde_json::json!(false));
        if let Some(include) = params
            .entry("include")
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            && !include
                .iter()
                .any(|item| item == "reasoning.encrypted_content")
        {
            include.push(serde_json::json!("reasoning.encrypted_content"));
        }
    }
    request
}

impl CompletionModel for OpenAiReplayModel {
    async fn completion(
        &self,
        request: CompletionRequest,
    ) -> Result<CompletionResponse, CompletionError> {
        self.0.completion(replay_contents(request)).await
    }

    async fn stream(
        &self,
        request: CompletionRequest,
    ) -> Result<StreamingCompletionResponse, CompletionError> {
        self.0.stream(replay_contents(request)).await
    }
}

#[cfg(test)]
mod tests {
    use rig::message::{Reasoning, ReasoningContent};
    use serde_json::json;

    use super::*;

    #[test]
    fn replays_legacy_history_with_only_portable_reasoning() {
        let encrypted = AssistantContent::Reasoning(Reasoning {
            id: Some("rs_encrypted".to_string()),
            content: vec![
                ReasoningContent::Summary("A useful summary".to_string()),
                ReasoningContent::Encrypted(" opaque bytes ".to_string()),
            ],
        });
        let client = openai::Client::builder()
            .api_key("test-key")
            .build()
            .unwrap();
        let request = client
            .completion_model("test-model")
            .completion_request("next")
            .messages([
                Message::user("earlier request"),
                Message::Assistant {
                    id: Some("msg_legacy".to_string()),
                    content: vec![AssistantContent::Reasoning(Reasoning {
                        id: Some("rs_legacy".to_string()),
                        content: vec![ReasoningContent::Summary("old summary".to_string())],
                    })],
                },
                Message::Assistant {
                    id: Some("msg_current".to_string()),
                    content: vec![encrypted.clone(), AssistantContent::text("earlier answer")],
                },
            ])
            .additional_params(json!({
                "store": true,
                "include": ["file_search_call.results"],
                "reasoning": { "effort": "medium" },
            }))
            .build();

        let request = replay_contents(request);
        assert_eq!(
            request.chat_history,
            vec![
                Message::user("earlier request"),
                Message::Assistant {
                    id: None,
                    content: vec![encrypted, AssistantContent::text("earlier answer")],
                },
                Message::user("next"),
            ]
        );
        assert_eq!(
            request.additional_params,
            Some(json!({
                "store": false,
                "include": ["file_search_call.results", "reasoning.encrypted_content"],
                "reasoning": { "effort": "medium" },
            }))
        );
    }
}
