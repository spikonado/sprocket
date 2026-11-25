use std::sync::Arc;

use rig::completion::{CompletionRequest, Message, Reasoning};
use rig::error::EncodeError;
use rig::http_client::DynHttpClient;
use rig::operation::Completion;
use rig::providers::gemini::GeminiConfig;
use rig::providers::gemini::completion::GenerateContent;
use rig::providers::gemini::extension::GeminiOptions;
use rig::wire::{Descriptor, Encoded, Mode, Wire, WireFrame};
use rig::{DynModel, Model};

pub(crate) fn generate_content_model(
    api_key: String,
    model: &str,
    instructions: &str,
) -> DynModel<Completion> {
    let wire = gemini_content(GeminiConfig::new(api_key), model, instructions, None);
    Model::new(wire, rig::rig_reqwest::shared()).erase()
}

/// `models_url` is the Vertex `publishers/google/models` URL; `http` authenticates.
pub(crate) fn vertex_generate_content_model(
    models_url: String,
    http: DynHttpClient,
    model: &str,
    instructions: &str,
) -> DynModel<Completion> {
    let wire = gemini_content(GeminiConfig::new(""), model, instructions, Some(models_url));
    Model::new(wire, http).erase()
}

fn gemini_content(
    config: GeminiConfig,
    model: &str,
    instructions: &str,
    vertex_models_url: Option<String>,
) -> GeminiContent {
    GeminiContent {
        wire: GenerateContent::new(config, model),
        instructions: instructions.to_string(),
        vertex_models_url,
    }
}

#[derive(Clone)]
struct GeminiContent {
    wire: GenerateContent,
    instructions: String,
    vertex_models_url: Option<String>,
}

impl Wire for GeminiContent {
    type Op = Completion;
    type Payload = Encoded;
    type Frame = WireFrame;
    type Event = <GenerateContent as Wire>::Event;
    type Decoder<'id> = <GenerateContent as Wire>::Decoder<'id>;
    type Reassembler = <GenerateContent as Wire>::Reassembler;

    fn describe(&self) -> Descriptor<'_> {
        self.wire.describe()
    }

    fn encode(&self, mut request: CompletionRequest, mode: Mode) -> Result<Encoded, EncodeError> {
        request
            .chat_history
            .insert(0, Arc::new(Message::system(self.instructions.clone())));
        if matches!(request.options.reasoning, Some(Reasoning::Effort(_))) {
            // Gemini omits thought summaries unless asked for them.
            request = request.provider_option(GeminiOptions::new().include_thoughts(true));
        }
        let model = request
            .model
            .clone()
            .unwrap_or_else(|| self.wire.model.clone());
        let mut encoded = self.wire.encode(request, mode)?;
        if let Some(models_url) = &self.vertex_models_url {
            let verb = match mode {
                Mode::Unary => "generateContent",
                Mode::Streaming => "streamGenerateContent?alt=sse",
            };
            *encoded.request.uri_mut() = format!("{models_url}/{model}:{verb}")
                .parse()
                .map_err(|_| EncodeError::request("Vertex AI model URL is invalid."))?;
        }
        Ok(encoded)
    }

    fn decoder<'id>(&self) -> Self::Decoder<'id> {
        self.wire.decoder()
    }
}

#[cfg(test)]
mod tests;
