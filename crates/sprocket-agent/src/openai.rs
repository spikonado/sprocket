use rig::completion::CompletionRequest;
use rig::error::EncodeError;
use rig::message::{AssistantContent, Message};
use rig::operation::Completion;
use rig::providers::openai::OpenAIConfig;
use rig::providers::openai::responses_api::wire::Responses;
use rig::wire::{Descriptor, Encoded, Mode, Wire, WireFrame};
use rig::{DynModel, Model};

use crate::reasoning::opaque_reasoning_blob;

pub(crate) fn stateless_responses_model(
    provider: OpenAIConfig,
    model: impl Into<String>,
) -> DynModel<Completion> {
    let model = provider.client().responses(model);
    Model::new(StatelessResponses(model.wire), model.transport).erase()
}

/// Rig preserves and inlines Responses items, including their IDs and phases.
/// Stateless runs additionally need opaque reasoning and explicit storage settings.
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
        // Keep Rig's provider item identities: it now sends complete items,
        // and dropping IDs loses message phase and other replay metadata.
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
        self.0.encode(request, mode)
    }

    fn decoder<'id>(&self) -> Self::Decoder<'id> {
        self.0.decoder()
    }
}
