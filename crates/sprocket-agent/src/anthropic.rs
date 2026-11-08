use std::sync::Arc;

use rig::catalog::{Catalog, ModelFacts};
use rig::completion::{CacheRetention, CompletionRequest, Message, Reasoning};
use rig::error::EncodeError;
use rig::operation::Completion;
use rig::providers::anthropic::wire::Auth;
use rig::providers::anthropic::{AnthropicConfig, Messages};
use rig::providers::registry::ProviderId;
use rig::wire::{Descriptor, Encoded, Mode, Wire, WireFrame};
use rig::{DynModel, Model};
use serde_json::{Map, Value, json};

/// Claude Code's output cap, for models Rig's catalog doesn't list.
const DEFAULT_MAX_TOKENS: u64 = 128_000;
const ROOT_COMBINATORS: [&str; 3] = ["anyOf", "oneOf", "allOf"];

/// A host serving Anthropic's Messages API.
pub(crate) struct MessagesHost {
    base_url: &'static str,
    auth: Auth,
}

pub(crate) const ANTHROPIC: MessagesHost = MessagesHost {
    base_url: "https://api.anthropic.com",
    auth: Auth::ApiKey,
};
pub(crate) const VERCEL: MessagesHost = MessagesHost {
    base_url: "https://ai-gateway.vercel.sh",
    auth: Auth::ApiKey,
};
pub(crate) const OPENROUTER: MessagesHost = MessagesHost {
    base_url: "https://openrouter.ai/api",
    auth: Auth::OptionalBearer,
};

/// `anthropic_model` is Anthropic's ID for `model`, which Rig's facts are keyed by, when the host
/// names it differently.
pub(crate) fn messages_model(
    host: &MessagesHost,
    api_key: String,
    model: &str,
    anthropic_model: Option<&str>,
    instructions: &str,
    cache_write_ttl: Option<&str>,
) -> DynModel<Completion> {
    let wire = claude_messages(
        host,
        api_key,
        model,
        anthropic_model,
        instructions,
        cache_write_ttl,
    );
    Model::new(wire, rig::rig_reqwest::shared()).erase()
}

fn claude_messages(
    host: &MessagesHost,
    api_key: String,
    model: &str,
    anthropic_model: Option<&str>,
    instructions: &str,
    cache_write_ttl: Option<&str>,
) -> ClaudeMessages {
    let mut config = AnthropicConfig::new(api_key).with_base_url(host.base_url);
    config.dialect.quirks.auth = host.auth;
    let mut wire = config.completion(model).with_prompt_caching();
    if let Some(spec) = anthropic_model.and_then(|anthropic_model| {
        Catalog::builtin().get_exact(ProviderId::catalog("anthropic")?, anthropic_model)
    }) {
        let mut spec = spec.clone();
        spec.id = model.to_string();
        wire = wire.with_facts(ModelFacts::new(spec));
    }
    if wire.default_max_tokens.is_none() {
        wire = wire.with_default_max_tokens(DEFAULT_MAX_TOKENS);
    }
    ClaudeMessages {
        wire,
        instructions: instructions.to_string(),
        // Cache writes must match the TTL the catalog prices usage by.
        cache: match cache_write_ttl {
            Some("1h") => CacheRetention::Long,
            _ => CacheRetention::Short,
        },
    }
}

#[derive(Clone)]
struct ClaudeMessages {
    wire: Messages,
    instructions: String,
    cache: CacheRetention,
}

impl Wire for ClaudeMessages {
    type Op = Completion;
    type Payload = Encoded;
    type Frame = WireFrame;
    type Event = <Messages as Wire>::Event;
    type Decoder<'id> = <Messages as Wire>::Decoder<'id>;
    type Reassembler = <Messages as Wire>::Reassembler;

    fn describe(&self) -> Descriptor<'_> {
        self.wire.describe()
    }

    fn encode(&self, mut request: CompletionRequest, mode: Mode) -> Result<Encoded, EncodeError> {
        request
            .chat_history
            .insert(0, Arc::new(Message::system(self.instructions.clone())));
        request.options = std::mem::take(&mut request.options).cache(self.cache);
        if matches!(request.options.reasoning, Some(Reasoning::Effort(_))) {
            // Claude omits thinking text unless asked for a summary.
            let params = request
                .additional_params
                .get_or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| {
                    EncodeError::request("Messages parameters must be a JSON object.")
                })?;
            if let Value::Object(thinking) = params.entry("thinking").or_insert_with(|| json!({})) {
                thinking.insert("display".to_string(), json!("summarized"));
            }
        }
        for tool in &mut request.tools {
            if let Some(parameters) = claude_tool_schema(&tool.parameters) {
                Arc::make_mut(tool).parameters = parameters;
            }
        }
        self.wire.encode(request, mode)
    }

    fn decoder<'id>(&self) -> Self::Decoder<'id> {
        self.wire.decoder()
    }
}

/// Claude rejects root combinators. Double negation keeps their validation unchanged.
fn claude_tool_schema(schema: &Value) -> Option<Value> {
    let schema = schema.as_object()?;
    if !ROOT_COMBINATORS.iter().any(|key| schema.contains_key(*key)) {
        return None;
    }
    let (constraints, mut root): (Map<String, Value>, Map<String, Value>) = schema
        .clone()
        .into_iter()
        .partition(|(key, _)| key == "not" || ROOT_COMBINATORS.contains(&key.as_str()));
    root.insert("not".to_string(), json!({ "not": constraints }));
    Some(Value::Object(root))
}

#[cfg(test)]
mod tests;
