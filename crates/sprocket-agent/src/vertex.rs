use std::future::Future;

use anyhow::anyhow;
use rig::DynModel;
use rig::http_client::{DynHttpClient, ReqwestClient};
use rig::operation::Completion;

use crate::gateway::BearerAuth;
use crate::types::{BearerCredential, VertexCredential};
use crate::{anthropic, gemini};

/// The global endpoint serves every Claude and Gemini model Vertex offers, at the lowest price.
fn publisher_models_url(project_id: &str, publisher: &str) -> String {
    format!(
        "https://aiplatform.googleapis.com/v1/projects/{project_id}/locations/global/publishers/{publisher}/models"
    )
}

pub(crate) fn vertex_model<F, Fut>(
    credential: VertexCredential,
    issue_credential: F,
    vendor: &str,
    model: &str,
    instructions: &str,
    cache_write_ttl: Option<&str>,
) -> anyhow::Result<DynModel<Completion>>
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = anyhow::Result<BearerCredential>> + Send + 'static,
{
    let http = DynHttpClient::new(ReqwestClient::from(reqwest::Client::new()))
        .with_middleware(BearerAuth::new(Some(credential.access), issue_credential));
    let project_id = &credential.project_id;
    match vendor {
        "anthropic" => Ok(anthropic::vertex_messages_model(
            publisher_models_url(project_id, "anthropic"),
            http,
            model,
            instructions,
            cache_write_ttl,
        )),
        "google" => Ok(gemini::vertex_generate_content_model(
            publisher_models_url(project_id, "google"),
            http,
            model,
            instructions,
        )),
        _ => Err(anyhow!("Google Vertex AI does not serve {vendor} models")),
    }
}
