use rig::completion::CompletionRequest;
use rig::error::EncodeError;
use rig::message::Message;
use rig::operation::Completion;
use rig::providers::openai::OpenAIConfig;
use rig::providers::openai::responses_api::{SystemInstructionsPlacement, wire::Responses};
use rig::wire::{Body, Descriptor, Encoded, Mode, Wire, WireFrame};
use rig::{DynModel, Model};

pub(crate) fn developer_message(text: impl Into<String>) -> Message {
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
    type Reassembler = <Responses as Wire>::Reassembler;

    fn describe(&self) -> Descriptor<'_> {
        self.0.describe()
    }

    fn encode(&self, mut request: CompletionRequest, mode: Mode) -> Result<Encoded, EncodeError> {
        // Rig filters unresolvable reasoning and requests ciphertext when store is false.
        let params = request
            .additional_params
            .get_or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or_else(|| EncodeError::request("Responses parameters must be a JSON object."))?;
        params.insert("store".to_string(), serde_json::json!(false));
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
    type Reassembler = <Responses as Wire>::Reassembler;

    fn describe(&self) -> Descriptor<'_> {
        self.0.describe()
    }

    fn encode(&self, request: CompletionRequest, mode: Mode) -> Result<Encoded, EncodeError> {
        // Rig 0.44 has no developer role or developer instruction placement.
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
    use serde_json::json;

    #[test]
    fn stateless_requests_keep_developer_messages_and_request_encrypted_reasoning() {
        let mut request = CompletionRequest::new("next");
        request
            .chat_history
            .insert(0, developer_message("Mid-run rule."));
        request.additional_params = Some(json!({
            "store": true,
            "include": ["message.output_text.logprobs"],
        }));
        let encoded = StatelessResponses(Responses::new(OpenAIConfig::new("test"), "gpt-5"))
            .encode(request, Mode::Streaming)
            .unwrap();
        let Body::Bytes(bytes) = encoded.request.into_body() else {
            panic!("Responses uses JSON");
        };
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["store"], false);
        assert_eq!(body["input"][0]["role"], "developer");
        assert_eq!(body["input"][0]["content"][0]["text"], "Mid-run rule.");
        assert_eq!(
            body["include"],
            json!([
                "message.output_text.logprobs",
                "reasoning.encrypted_content",
            ])
        );
    }
}
