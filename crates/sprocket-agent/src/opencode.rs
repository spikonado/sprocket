use std::sync::Arc;

use rig::completion::{CompletionRequest, Message};
use rig::error::EncodeError;
use rig::http_client::HeaderValue;
use rig::operation::Completion;
use rig::providers::anthropic::AnthropicConfig;
use rig::providers::openai::OpenAIConfig;
use rig::providers::openai::responses_api::wire::Responses;
use rig::providers::openai::wire::Dialect;
use rig::wire::{Descriptor, Encoded, Mode, Wire, WireFrame};
use rig::{DynModel, Model};

use crate::anthropic::claude_messages;
use crate::openai::StatelessResponses;

const USER_AGENT: &str = concat!("sprocket/", env!("CARGO_PKG_VERSION"));
const SESSION_HEADER: &str = "x-opencode-session";

/// OpenCode serves Claude only on Messages, OpenAI models only on Responses, and open models
/// only on Chat Completions.
/// `session_id` keeps a thread on one route and prompt cache, which Go requires.
pub(crate) fn completion_model(
    dialect: &'static Dialect,
    api_key: String,
    model: &str,
    vendor: &str,
    cache_write_ttl: Option<&str>,
    instructions: &str,
    session_id: &str,
) -> anyhow::Result<DynModel<Completion>> {
    let session = HeaderValue::from_str(session_id)?;
    let base_url = dialect.base_url;
    let transport = rig::rig_reqwest::shared();
    Ok(match vendor {
        "anthropic" => {
            let config =
                AnthropicConfig::new(api_key).with_base_url(format!("{base_url}/anthropic"));
            let wire = claude_messages(config, model, instructions, cache_write_ttl);
            Model::new(OpencodeWire::new(wire, session, None), transport).erase()
        }
        "openai" => {
            let config = OpenAIConfig::new(api_key)
                .with_base_url(format!("{base_url}/openai/v1"))
                .with_instructions(instructions);
            let wire = StatelessResponses(Responses::new(config, model));
            Model::new(OpencodeWire::new(wire, session, None), transport).erase()
        }
        _ => {
            // The dialect names the field each model replays its reasoning under.
            let wire = OpenAIConfig::with_key(dialect, api_key).chat(model);
            let instructions = Some(instructions.to_string());
            Model::new(OpencodeWire::new(wire, session, instructions), transport).erase()
        }
    })
}

/// Adds the headers OpenCode expects, and `instructions` as a leading system message for
/// wires that don't carry them.
#[derive(Clone)]
struct OpencodeWire<W> {
    wire: W,
    session: HeaderValue,
    instructions: Option<String>,
}

impl<W> OpencodeWire<W> {
    fn new(wire: W, session: HeaderValue, instructions: Option<String>) -> Self {
        Self {
            wire,
            session,
            instructions,
        }
    }
}

impl<W> Wire for OpencodeWire<W>
where
    W: Wire<Op = Completion, Payload = Encoded, Frame = WireFrame>,
{
    type Op = Completion;
    type Payload = Encoded;
    type Frame = WireFrame;
    type Event = W::Event;
    type Decoder<'id> = W::Decoder<'id>;
    type Reassembler = W::Reassembler;

    fn describe(&self) -> Descriptor<'_> {
        self.wire.describe()
    }

    fn encode(&self, mut request: CompletionRequest, mode: Mode) -> Result<Encoded, EncodeError> {
        if let Some(instructions) = &self.instructions {
            request
                .chat_history
                .insert(0, Arc::new(Message::system(instructions.clone())));
        }
        let mut encoded = self.wire.encode(request, mode)?;
        let headers = encoded.request.headers_mut();
        headers.insert(
            http::header::USER_AGENT,
            HeaderValue::from_static(USER_AGENT),
        );
        headers.insert(SESSION_HEADER, self.session.clone());
        Ok(encoded)
    }

    fn decoder<'id>(&self) -> Self::Decoder<'id> {
        self.wire.decoder()
    }
}

#[cfg(test)]
mod tests;
