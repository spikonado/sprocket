use rig::completion::CompletionRequest;
use rig::error::EncodeError;
use rig::operation::Completion;
use rig::providers::openai::responses_api::wire::Responses;
use rig::providers::openai::wire::Auth;
use rig::providers::openai::{OpenAI, OpenAIConfig};
use rig::wire::{Descriptor, Encoded, Mode, Wire, WireFrame};
use rig::{DynModel, Model};

/// For transports that set `Authorization` themselves.
pub(crate) fn transport_auth_config() -> OpenAIConfig {
    OpenAIConfig::new("").with_auth(Auth::OptionalBearer)
}

pub(crate) fn stateless_responses_model(
    client: OpenAI,
    model: impl Into<String>,
) -> DynModel<Completion> {
    let model = client.responses(model);
    Model::new(StatelessResponses::new(model.wire), model.transport).erase()
}

/// Sends system messages as `developer` items in `input`.
pub(crate) fn developer_messages(mut wire: Responses) -> Responses {
    wire.provider.dialect.quirks.responses.system_role = "developer";
    wire.with_system_instructions_as_messages()
}

// Rig sets `store` per request only. Remove once it has a per-model setting.
#[derive(Clone)]
pub(crate) struct StatelessResponses {
    wire: Responses,
    relaxed_content_type: bool,
}

impl StatelessResponses {
    pub(crate) fn new(wire: Responses) -> Self {
        Self {
            wire: developer_messages(wire),
            relaxed_content_type: false,
        }
    }

    pub(crate) fn with_relaxed_content_type(mut self) -> Self {
        self.relaxed_content_type = true;
        self
    }
}

impl Wire for StatelessResponses {
    type Op = Completion;
    type Payload = Encoded;
    type Frame = WireFrame;
    type Event = <Responses as Wire>::Event;
    type Decoder<'id> = <Responses as Wire>::Decoder<'id>;
    type Reassembler = <Responses as Wire>::Reassembler;

    fn describe(&self) -> Descriptor<'_> {
        self.wire.describe()
    }

    fn encode(&self, mut request: CompletionRequest, mode: Mode) -> Result<Encoded, EncodeError> {
        // Rig filters unresolvable reasoning and requests ciphertext when store is false.
        let params = request
            .additional_params
            .get_or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or_else(|| EncodeError::request("Responses parameters must be a JSON object."))?;
        params.insert("store".to_string(), serde_json::json!(false));
        let encoded = self.wire.encode(request, mode)?;
        Ok(if self.relaxed_content_type {
            encoded.with_relaxed_content_type()
        } else {
            encoded
        })
    }

    fn decoder<'id>(&self) -> Self::Decoder<'id> {
        self.wire.decoder()
    }
}

#[cfg(test)]
mod tests;
