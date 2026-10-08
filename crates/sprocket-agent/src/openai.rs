use rig::completion::CompletionRequest;
use rig::error::EncodeError;
use rig::message::{AssistantContent, Message};
use rig::operation::Completion;
use rig::providers::openai::OpenAIConfig;
use rig::providers::openai::responses_api::{SystemInstructionsPlacement, wire::Responses};
use rig::wire::{Body, Descriptor, Encoded, Mode, Wire, WireFrame};
use rig::{DynModel, Model};

use crate::reasoning::opaque_reasoning_blob;

pub(crate) fn developer_message(text: impl Into<String>) -> Message {
    // Rig has no developer variant; the Responses wire assigns the application role.
    Message::system(text)
}

pub(crate) fn stateless_responses_model(
    provider: OpenAIConfig,
    model: impl Into<String>,
) -> DynModel<Completion> {
    let model = provider.client().responses(model);
    Model::new(StatelessResponses(model.wire), model.transport).erase()
}

#[derive(Clone)]
pub(crate) struct StatelessResponses(pub(crate) Responses);

impl Wire for StatelessResponses {
    type Op = Completion;
    type Payload = Encoded;
    type Frame = WireFrame;
    type Decoder<'id> = <Responses as Wire>::Decoder<'id>;

    fn describe(&self) -> Descriptor<'_> {
        self.0.describe()
    }

    fn encode(&self, mut request: CompletionRequest, mode: Mode) -> Result<Encoded, EncodeError> {
        // Summary-only reasoning cannot be replayed against store:false.
        request.chat_history.retain_mut(|message| {
            if let Message::Assistant { content, .. } = message {
                content.retain(|part| match part {
                    AssistantContent::Reasoning(reasoning) => {
                        opaque_reasoning_blob(reasoning).is_some()
                    }
                    _ => true,
                });
                return !content.is_empty();
            }
            true
        });
        let params = request
            .additional_params
            .get_or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or_else(|| EncodeError::request("Responses parameters must be a JSON object."))?;
        params.insert("store".to_string(), serde_json::json!(false));
        let include = params
            .entry("include")
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .ok_or_else(|| EncodeError::request("Responses include fields must be an array."))?;
        if !include
            .iter()
            .any(|item| item == "reasoning.encrypted_content")
        {
            include.push(serde_json::json!("reasoning.encrypted_content"));
        }
        DeveloperResponses(self.0.clone()).encode(request, mode)
    }

    fn decoder<'id>(&self) -> Self::Decoder<'id> {
        self.0.decoder()
    }
}

#[derive(Clone)]
pub(crate) struct DeveloperResponses(pub(crate) Responses);

impl Wire for DeveloperResponses {
    type Op = Completion;
    type Payload = Encoded;
    type Frame = WireFrame;
    type Decoder<'id> = <Responses as Wire>::Decoder<'id>;

    fn describe(&self) -> Descriptor<'_> {
        self.0.describe()
    }

    fn encode(&self, request: CompletionRequest, mode: Mode) -> Result<Encoded, EncodeError> {
        let mut encoded = self
            .0
            .clone()
            .with_system_instructions_placement(SystemInstructionsPlacement::InputSystemMessages)
            .encode(request, mode)?;
        let Body::Bytes(bytes) = encoded.request.body_mut() else {
            return Err(EncodeError::request("Responses requires a JSON body."));
        };
        let mut body: serde_json::Value = serde_json::from_slice(bytes)
            .map_err(|error| EncodeError::request(error.to_string()))?;
        let input = body["input"]
            .as_array_mut()
            .ok_or_else(|| EncodeError::request("Responses input must be an array."))?;
        for item in input {
            if item["role"] == "system" {
                item["role"] = serde_json::json!("developer");
            }
        }
        *bytes =
            serde_json::to_vec(&body).map_err(|error| EncodeError::request(error.to_string()))?;
        Ok(encoded)
    }

    fn decoder<'id>(&self) -> Self::Decoder<'id> {
        self.0.decoder()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn body(request: CompletionRequest) -> Value {
        let encoded = StatelessResponses(Responses::new(
            OpenAIConfig::new("test-key").with_instructions("Base instructions."),
            "model",
        ))
        .encode(request, Mode::Streaming)
        .expect("Responses request");
        let Body::Bytes(bytes) = encoded.request.into_body() else {
            panic!("Responses JSON body");
        };
        serde_json::from_slice(&bytes).expect("Responses JSON")
    }

    #[test]
    fn late_developer_instructions_preserve_the_existing_request_prefix() {
        let previous = body(CompletionRequest::new("work"));
        let next = body(
            CompletionRequest::new(developer_message("continue")).messages([
                Message::user("work"),
                Message::assistant("Completed step one."),
            ]),
        );
        assert_eq!(next["instructions"], previous["instructions"]);
        assert_eq!(next["input"][0], previous["input"][0]);
        assert_eq!(next["input"][1]["role"], "assistant");
        assert_eq!(next["input"][2]["role"], "developer");
        assert_eq!(next["input"][2]["content"][0]["text"], "continue");
    }

    #[test]
    fn leading_developer_instructions_stay_separate_from_base_instructions_and_user_content() {
        let request = body(CompletionRequest::new("user request").messages([
            developer_message("Application policy."),
            Message::user("Workspace instructions and handoff summary."),
        ]));
        assert_eq!(request["instructions"], json!("Base instructions."));
        assert_eq!(request["input"][0]["role"], "developer");
        assert_eq!(request["input"][1]["role"], "user");
        assert_eq!(request["input"][2]["role"], "user");
    }
}
