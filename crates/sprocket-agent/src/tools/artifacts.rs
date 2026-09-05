use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::context::{AgentToolContext, tool_error};
use super::job::{execute_tool_job, mutation_args_from_payload, run_convex_tool_mutation};

#[derive(Clone)]
pub(crate) struct CreateArtifactTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct UpdateArtifactTool(pub(super) AgentToolContext);

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct CreateArtifactArgs {
    /// Title for the artifact.
    pub(crate) title: String,
    #[serde(rename = "contentType")]
    pub(crate) content_type: ArtifactContentType,
    /// Full content of the artifact.
    pub(crate) content: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ArtifactContentType {
    Markdown,
    Html,
    React,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct UpdateArtifactArgs {
    /// ID of the artifact to update.
    #[serde(rename = "artifactId")]
    pub(crate) artifact_id: String,
    /// The new full content of the artifact.
    pub(crate) content: String,
}

impl rig::tool::Tool for CreateArtifactTool {
    const NAME: &'static str = "create_artifact";
    type Error = ToolExecutionError;
    type Args = CreateArtifactArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Create a markdown/html/react artifact that's rendered for the user.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(CreateArtifactArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload.clone(),
            |cancellation| async {
                let mutation_args =
                    mutation_args_from_payload(&self.0.run_id, &self.0.claim_id, &payload)?;
                run_convex_tool_mutation(
                    &self.0.runtime,
                    cancellation,
                    "artifacts:createArtifact",
                    mutation_args,
                )
                .await
            },
        )
        .await
    }
}

impl rig::tool::Tool for UpdateArtifactTool {
    const NAME: &'static str = "update_artifact";
    type Error = ToolExecutionError;
    type Args = UpdateArtifactArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Replace an existing artifact's content, creating a new version.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(UpdateArtifactArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload.clone(),
            |cancellation| async {
                let mutation_args =
                    mutation_args_from_payload(&self.0.run_id, &self.0.claim_id, &payload)?;
                run_convex_tool_mutation(
                    &self.0.runtime,
                    cancellation,
                    "artifacts:appendArtifactVersion",
                    mutation_args,
                )
                .await
            },
        )
        .await
    }
}
