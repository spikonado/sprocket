use std::sync::Arc;

use rig::completion::{CompletionRequest, Reasoning};
use rig::error::EncodeError;
use rig::operation::Completion;
use rig::providers::openai::OpenAIConfig;
use rig::providers::openai::responses_api::streaming::{ResponsesDecoder, ResponsesEvent};
use rig::providers::openai::responses_api::wire::Responses;
use rig::wire::{Decoder, Descriptor, Encoded, Flow, Mode, Out, Wire, WireEvent, WireFrame};
use rig::{DynModel, Model, ProviderError};
use serde_json::{Map, Value, json};

use crate::anthropic::claude_tool_schema;
use crate::openai::StatelessResponses;

const APP_URL: &str = "https://usesprocket.dev";
const APP_TITLE: &str = "Sprocket";
const OPENROUTER_APP_CATEGORIES: &str = "programming-app,cloud-agent";
const USER_AGENT: &str = concat!("sprocket/", env!("CARGO_PKG_VERSION"));

/// A third-party gateway serving the Responses API for every vendor's models.
#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum ResponsesGateway {
    Vercel,
    Openrouter,
    Opencode,
    OpencodeGo,
}

impl ResponsesGateway {
    fn base_url(self) -> &'static str {
        match self {
            Self::Vercel => "https://ai-gateway.vercel.sh/v1",
            Self::Openrouter => "https://openrouter.ai/api/v1",
            Self::Opencode => "https://opencode.ai/inference/openai/v1",
            Self::OpencodeGo => "https://opencode.ai/inference/go/openai/v1",
        }
    }
}

/// `cache_write_ttl` is the catalog's, which Claude's cache writes must match.
/// `session_id` keeps an OpenCode thread on one route and prompt cache, which Go requires.
pub(crate) fn gateway_responses_model(
    gateway: ResponsesGateway,
    api_key: String,
    model: &str,
    claude: bool,
    cache_write_ttl: Option<&str>,
    instructions: &str,
    session_id: &str,
) -> anyhow::Result<DynModel<Completion>> {
    Ok(Model::new(
        gateway_responses(
            gateway,
            api_key,
            model,
            claude,
            cache_write_ttl,
            instructions,
            session_id,
        )?,
        rig::rig_reqwest::shared(),
    )
    .erase())
}

fn gateway_responses(
    gateway: ResponsesGateway,
    api_key: String,
    model: &str,
    claude: bool,
    cache_write_ttl: Option<&str>,
    instructions: &str,
    session_id: &str,
) -> anyhow::Result<GatewayResponses> {
    let mut config = OpenAIConfig::new(api_key)
        .with_base_url(gateway.base_url())
        .with_instructions(instructions);
    if gateway == ResponsesGateway::Openrouter {
        // OpenRouter replays Claude's thinking through the item's `signature`, not ciphertext.
        config.dialect.quirks.responses.reasoning_ciphertext = false;
    }
    Ok(GatewayResponses {
        wire: StatelessResponses::new(Responses::new(config, model)),
        gateway,
        claude,
        cache_write_ttl: cache_write_ttl.map(str::to_string),
        session: http::HeaderValue::from_str(session_id)?,
    })
}

#[derive(Clone)]
struct GatewayResponses {
    wire: StatelessResponses,
    gateway: ResponsesGateway,
    claude: bool,
    cache_write_ttl: Option<String>,
    session: http::HeaderValue,
}

impl GatewayResponses {
    fn add_params(&self, reasoning: Option<&Reasoning>, params: &mut Map<String, Value>) {
        if self.gateway == ResponsesGateway::Vercel {
            params.insert("caching".to_string(), json!("auto"));
        }
        if !self.claude {
            return;
        }
        match self.gateway {
            ResponsesGateway::Vercel => {
                if let Some(Reasoning::Effort(effort)) = reasoning {
                    // Vercel applies `reasoning.summary` only to OpenAI, and `thinking`
                    // overrides `reasoning`, so effort is repeated.
                    params.insert(
                        "providerOptions".to_string(),
                        json!({"anthropic": {
                            "thinking": {"type": "adaptive", "display": "summarized"},
                            "effort": effort.as_str(),
                        }}),
                    );
                }
                if let Some(ttl) = &self.cache_write_ttl {
                    params.insert("cache_ttl".to_string(), json!(ttl));
                }
                // Keeps the instructions cached when later history changes.
                params.insert("cache_anchor_items".to_string(), json!(1));
            }
            ResponsesGateway::Openrouter => {
                let mut cache_control = json!({"type": "ephemeral"});
                if let Some(ttl) = &self.cache_write_ttl {
                    cache_control["ttl"] = json!(ttl);
                }
                params.insert("cache_control".to_string(), cache_control);
            }
            ResponsesGateway::Opencode | ResponsesGateway::OpencodeGo => {}
        }
    }
}

impl Wire for GatewayResponses {
    type Op = Completion;
    type Payload = Encoded;
    type Frame = WireFrame;
    type Event = ResponsesEvent;
    type Decoder<'id> = SpecReasoningEvents;
    type Reassembler = <Responses as Wire>::Reassembler;

    fn describe(&self) -> Descriptor<'_> {
        self.wire.describe()
    }

    fn encode(&self, mut request: CompletionRequest, mode: Mode) -> Result<Encoded, EncodeError> {
        let params = request
            .additional_params
            .get_or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| EncodeError::request("Responses parameters must be a JSON object."))?;
        self.add_params(request.options.reasoning.as_ref(), params);
        if self.claude {
            for tool in &mut request.tools {
                if let Some(parameters) = claude_tool_schema(&tool.parameters) {
                    Arc::make_mut(tool).parameters = parameters;
                }
            }
        }
        let mut encoded = self.wire.encode(request, mode)?;
        let headers = encoded.request.headers_mut();
        headers.insert("http-referer", http::HeaderValue::from_static(APP_URL));
        headers.insert("x-title", http::HeaderValue::from_static(APP_TITLE));
        match self.gateway {
            ResponsesGateway::Vercel => {}
            ResponsesGateway::Openrouter => {
                headers.insert(
                    "x-openrouter-categories",
                    http::HeaderValue::from_static(OPENROUTER_APP_CATEGORIES),
                );
            }
            ResponsesGateway::Opencode | ResponsesGateway::OpencodeGo => {
                headers.insert(
                    http::header::USER_AGENT,
                    http::HeaderValue::from_static(USER_AGENT),
                );
                headers.insert("x-opencode-session", self.session.clone());
            }
        }
        Ok(encoded)
    }

    fn decoder<'id>(&self) -> Self::Decoder<'id> {
        SpecReasoningEvents(self.wire.decoder())
    }
}

struct SpecReasoningEvents(ResponsesDecoder);

impl<'id> Decoder<'id, Completion> for SpecReasoningEvents {
    type Event = ResponsesEvent;

    fn classify(&self, frame: WireFrame) -> WireEvent<ResponsesEvent> {
        self.0.classify(spec_reasoning_event(frame))
    }

    fn decode(
        &mut self,
        event: ResponsesEvent,
        out: Out<'id, Completion>,
    ) -> Result<Flow, ProviderError> {
        self.0.decode(event, out)
    }

    fn eof(&mut self, out: Out<'id, Completion>) -> Result<Flow, ProviderError> {
        self.0.eof(out)
    }
}

/// Gateways stream Claude's thinking under event types the Responses spec doesn't define.
fn spec_reasoning_event(frame: WireFrame) -> WireFrame {
    let event = {
        let text = frame.as_str();
        text.contains("\"response.reasoning.")
            .then(|| serde_json::from_str::<Value>(&text).ok())
            .flatten()
    };
    let Some(mut event) = event else {
        return frame;
    };
    let kind = match event["type"].as_str() {
        Some("response.reasoning.delta") => "response.reasoning_text.delta",
        Some("response.reasoning.done") => "response.reasoning_text.done",
        _ => return frame,
    };
    event["type"] = json!(kind);
    WireFrame::Text(event.to_string())
}

#[cfg(test)]
mod tests;
