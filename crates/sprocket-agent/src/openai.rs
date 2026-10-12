use rig::completion::CompletionRequest;
use rig::error::EncodeError;
use rig::message::{AssistantContent, Message};
use rig::operation::Completion;
use rig::providers::openai::OpenAIConfig;
use rig::providers::openai::responses_api::streaming::{
    ItemChunk, ResponseChunk, ResponsesDecoder, ResponsesEvent, StreamingCompletionChunk,
};
use rig::providers::openai::responses_api::{SystemInstructionsPlacement, wire::Responses};
use rig::wire::{Body, Decoder, Descriptor, Encoded, Flow, Mode, Out, Wire, WireEvent, WireFrame};
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
    type Decoder<'id> = CompatibleResponsesDecoder<'id>;

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
        CompatibleResponsesDecoder(self.0.decoder())
    }
}

#[derive(Clone)]
pub(crate) struct DeveloperResponses(pub(crate) Responses);

impl Wire for DeveloperResponses {
    type Op = Completion;
    type Payload = Encoded;
    type Frame = WireFrame;
    type Decoder<'id> = CompatibleResponsesDecoder<'id>;

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
        CompatibleResponsesDecoder(self.0.decoder())
    }
}

pub(crate) struct CompatibleResponsesDecoder<'id>(ResponsesDecoder<'id>);

impl<'id> Decoder<'id, Completion> for CompatibleResponsesDecoder<'id> {
    type Event = ResponsesEvent;

    fn classify(&self, frame: WireFrame) -> WireEvent<Self::Event> {
        let data = frame.as_str().into_owned();
        let classified = self.0.classify(WireFrame::Text(data.clone()));
        if !matches!(classified, WireEvent::Corrupt(_)) {
            return classified;
        }
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&data) else {
            return classified;
        };
        let Some(kind) = value["type"].as_str().map(str::to_owned) else {
            return classified;
        };
        if !matches!(
            kind.as_str(),
            "response.created"
                | "response.in_progress"
                | "response.completed"
                | "response.failed"
                | "response.incomplete"
        ) {
            return match serde_json::from_value::<ItemChunk>(value) {
                Err(error) => WireEvent::malformed(format!("Invalid {kind} event: {error}")),
                Ok(_) => classified,
            };
        }
        if let Some(timestamp) = value["response"]["created_at"].as_number()
            && timestamp.is_f64()
            && let Some(seconds) = timestamp.as_f64()
            && seconds >= 0.0
            && seconds < u64::MAX as f64
        {
            // OpenAI timestamps now allow fractions; Rig 0.43 stores whole seconds.
            value["response"]["created_at"] = serde_json::json!(seconds as u64);
        }
        match serde_json::from_value::<ResponseChunk>(value) {
            Ok(chunk) => WireEvent::Known(ResponsesEvent::Frame {
                raw: data,
                chunk: StreamingCompletionChunk::Response(chunk),
            }),
            Err(error) => WireEvent::malformed(format!("Invalid {kind} event: {error}")),
        }
    }

    fn decode(
        &mut self,
        event: Self::Event,
        out: Out<'id, Completion>,
    ) -> Result<Flow, rig::ProviderError> {
        self.0.decode(event, out)
    }

    fn eof(&mut self, out: Out<'id, Completion>) -> Result<Flow, rig::ProviderError> {
        self.0.eof(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn lifecycle_events_accept_fractional_and_integer_timestamps() {
        let decoder = CompatibleResponsesDecoder(ResponsesDecoder::new("openai"));
        for kind in [
            "response.created",
            "response.in_progress",
            "response.completed",
            "response.failed",
            "response.incomplete",
        ] {
            for (timestamp, whole_seconds) in [
                (json!(0.125), 0),
                (json!(1791807140.125), 1791807140),
                (json!(1791807140.0), 1791807140),
                (json!(1791807140), 1791807140),
            ] {
                let event = json!({
                    "type": kind,
                    "sequence_number": 0,
                    "response": {
                        "id": "resp_test", "object": "response",
                        "created_at": timestamp, "status": "in_progress",
                        "model": "model", "output": [], "tools": [],
                    },
                });
                let raw = event.to_string();
                let WireEvent::Known(ResponsesEvent::Frame {
                    raw: preserved,
                    chunk: StreamingCompletionChunk::Response(chunk),
                }) = decoder.classify(WireFrame::Text(raw.clone()))
                else {
                    panic!("expected lifecycle event: {raw}");
                };
                assert_eq!(chunk.response.created_at, whole_seconds);
                assert_eq!(preserved, raw);
            }
        }
    }

    #[test]
    fn lifecycle_schema_errors_identify_the_invalid_field() {
        let decoder = CompatibleResponsesDecoder(ResponsesDecoder::new("openai"));
        let event = json!({
            "type": "response.created", "sequence_number": 0,
            "response": {
                "id": "resp_test", "object": "response", "created_at": 1791807140.125,
                "status": "in_progress", "output": [], "tools": [],
            },
        });
        let WireEvent::Corrupt(error) = decoder.classify(WireFrame::Text(event.to_string())) else {
            panic!("expected schema error");
        };
        assert!(error.to_string().contains("response.created"));
        assert!(error.to_string().contains("missing field `model`"));
    }

    #[test]
    fn item_schema_errors_identify_the_event_and_missing_field() {
        let decoder = CompatibleResponsesDecoder(ResponsesDecoder::new("openai"));
        let event = json!({
            "type": "response.output_text.delta", "sequence_number": 0,
            "output_index": 0, "content_index": 0,
        });
        let WireEvent::Corrupt(error) = decoder.classify(WireFrame::Text(event.to_string())) else {
            panic!("expected schema error");
        };
        assert!(error.to_string().contains("response.output_text.delta"));
        assert!(error.to_string().contains("missing field `delta`"));
    }

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
