use rig::operation::Completion;
use rig::providers::openai::responses_api::wire::Responses;
use rig::providers::openai::wire::Auth;
use rig::providers::openai::{OpenAI, OpenAIConfig};
use rig::{DynModel, Model};

pub(crate) fn transport_auth_config() -> OpenAIConfig {
    OpenAIConfig::new("").with_auth(Auth::OptionalBearer)
}

pub(crate) fn stateless_responses_model(
    client: OpenAI,
    model: impl Into<String>,
) -> DynModel<Completion> {
    let model = client.responses(model);
    Model::new(stateless(model.wire), model.transport).erase()
}

pub(crate) fn developer_messages(mut wire: Responses) -> Responses {
    wire.provider.dialect.quirks.responses.system_role = "developer";
    wire.with_system_instructions_as_messages()
}

pub(crate) fn stateless(wire: Responses) -> Responses {
    developer_messages(wire).with_store(false)
}

#[cfg(test)]
mod tests;
