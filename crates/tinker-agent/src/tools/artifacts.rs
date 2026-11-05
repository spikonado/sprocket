use std::path::Path;

use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tinker_workspace::artifact_bindings::{
    ArtifactBinding, content_hash, normalize_destination, save_new_file,
};
use tinker_workspace::{MAX_ARTIFACT_BYTES, WorkspaceCancellation, read_artifact_file};

use super::context::{AgentToolContext, cancelled_error, tool_error};
use super::job::{execute_tool_job, mutation_args_from_payload, run_convex_tool_mutation};

#[derive(Clone)]
pub(crate) struct BindArtifactTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct ListArtifactsTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct SaveArtifactTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct DeleteArtifactTool(pub(super) AgentToolContext);

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeleteArtifactArgs {
    pub(crate) artifact_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BindArtifactArgs {
    pub(crate) path: String,
    /// Existing artifact to rebind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) artifact_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveArtifactArgs {
    pub(crate) artifact_id: String,
    pub(crate) path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ListArtifactsArgs {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactPage {
    page: Vec<ListedArtifact>,
    is_done: bool,
    continue_cursor: String,
    #[serde(deserialize_with = "tinker_convex::deserialize_convex_u64")]
    revision: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedArtifact {
    artifact_id: String,
    title: String,
}

fn absolute_path(workspace_root: &Path, local_path: &str) -> String {
    workspace_root
        .join(local_path)
        .to_string_lossy()
        .into_owned()
}

fn bound_artifact(
    context: &AgentToolContext,
    artifact_id: &str,
    local_path: &str,
) -> serde_json::Value {
    json!({
        "artifactId": artifact_id,
        "path": absolute_path(&context.workspace_root, local_path),
    })
}

fn artifact_summary(
    artifact: ListedArtifact,
    bindings: &[ArtifactBinding],
    workspace_root: &Path,
) -> serde_json::Value {
    let mut summary = json!({
        "artifactId": artifact.artifact_id,
        "title": artifact.title,
    });
    if let Some(binding) = bindings
        .iter()
        .find(|binding| binding.artifact_id.as_ref() == Some(&artifact.artifact_id))
    {
        summary["path"] = json!(absolute_path(workspace_root, &binding.local_path));
    }
    summary
}

async fn register_file(
    context: &AgentToolContext,
    cancellation: WorkspaceCancellation,
    path: &str,
    artifact_id: Option<String>,
) -> Result<serde_json::Value, ToolExecutionError> {
    let path = &context.workspace_relative_path(path);
    let mut bindings = tokio::select! {
        _ = cancellation.cancelled() => return Err(cancelled_error()),
        result = context.artifact_bindings.lock() => result.map_err(tool_error)?,
    };
    let file = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(cancelled_error()),
        result = read_artifact_file(&context.workspace_root, path) => result.map_err(tool_error)?,
    };
    let (registration_id, existing_id, baseline) = match artifact_id {
        Some(id) => (String::new(), Some(id), content_hash(&file.content)),
        None => {
            let path = bindings
                .at_path(&context.workspace_root, &file.local_path)
                .await
                .map_err(tool_error)?
                .map(|binding| binding.local_path)
                .unwrap_or_else(|| file.local_path.clone());
            let binding = bindings.reserve(path);
            if binding.content_hash.is_empty() {
                binding.content_hash = content_hash(&file.content);
            }
            let identity = (
                binding.registration_id.clone(),
                binding.artifact_id.clone(),
                binding.content_hash.clone(),
            );
            bindings.persist().await.map_err(tool_error)?;
            identity
        }
    };
    let (function, mut fields, existing) = if let Some(id) = &existing_id {
        let artifact = tokio::select! {
            _ = cancellation.cancelled() => return Err(cancelled_error()),
            result = get_artifact(context, id) => result?,
        };
        (
            "artifacts:editArtifact",
            json!({"artifactId": id, "expectedRevision": artifact.revision}),
            Some(artifact),
        )
    } else {
        (
            "artifacts:addArtifact",
            json!({"registrationId": registration_id}),
            None,
        )
    };
    let mut binding = ArtifactBinding {
        registration_id: existing
            .as_ref()
            .map(|artifact| artifact.registration_id.clone())
            .unwrap_or(registration_id),
        artifact_id: existing_id,
        local_path: file.local_path.clone(),
        content_hash: if existing.is_some() {
            content_hash(&file.content)
        } else {
            baseline
        },
    };
    bindings
        .validate_destination(&context.workspace_root, &binding)
        .await
        .map_err(tool_error)?;
    if binding.artifact_id.is_some() {
        bindings.bind(binding.clone()).map_err(tool_error)?;
    }
    fields["content"] = json!(file.content);
    fields["title"] = json!(file.title);
    let mutation_args = mutation_args_from_payload(&context.run_id, &context.claim_id, &fields)?;
    let result =
        run_convex_tool_mutation(&context.runtime, cancellation, function, mutation_args).await?;
    let artifact_id = result["artifactId"]
        .as_str()
        .ok_or_else(|| tool_error(anyhow::anyhow!("Artifact response has no ID")))?
        .to_string();
    binding.artifact_id = Some(artifact_id.clone());
    bindings.bind(binding).map_err(tool_error)?;
    bindings.persist().await.map_err(tool_error)?;
    Ok(bound_artifact(context, &artifact_id, &file.local_path))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredArtifact {
    #[serde(rename = "_id")]
    id: String,
    registration_id: String,
    content: String,
    #[serde(deserialize_with = "tinker_convex::deserialize_convex_u64")]
    revision: u64,
}

async fn get_artifact(
    context: &AgentToolContext,
    artifact_id: &str,
) -> Result<StoredArtifact, ToolExecutionError> {
    let args = mutation_args_from_payload(
        &context.run_id,
        &context.claim_id,
        &json!({"artifactId": artifact_id}),
    )?;
    context
        .runtime
        .query_json("artifacts:getArtifactForRun", args)
        .await
        .map_err(tool_error)
}

impl rig::tool::Tool for BindArtifactTool {
    const NAME: &'static str = "bind_artifact";
    type Error = ToolExecutionError;
    type Args = BindArtifactArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        format!(
            "Bind a UTF-8 file of at most {MAX_ARTIFACT_BYTES} bytes to a new artifact, or to an existing one. Later edits to the file sync."
        )
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(BindArtifactArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|error| tool_error(error.into()))?;
        execute_tool_job(&self.0, Self::NAME, payload, |cancellation| async move {
            register_file(&self.0, cancellation, &args.path, args.artifact_id).await
        })
        .await
    }
}

impl rig::tool::Tool for SaveArtifactTool {
    const NAME: &'static str = "save_artifact";
    type Error = ToolExecutionError;
    type Args = SaveArtifactArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Write an artifact's content to a new file and bind it.".into()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(SaveArtifactArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|error| tool_error(error.into()))?;
        let path = self.0.workspace_relative_path(&args.path);
        execute_tool_job(&self.0, Self::NAME, payload, |cancellation| async move {
            let mut bindings = tokio::select! {
                _ = cancellation.cancelled() => return Err(cancelled_error()),
                result = self.0.artifact_bindings.lock() => result.map_err(tool_error)?,
            };
            let artifact = tokio::select! {
                _ = cancellation.cancelled() => return Err(cancelled_error()),
                result = get_artifact(&self.0, &args.artifact_id) => result?,
            };
            if cancellation.is_cancelled() {
                return Err(cancelled_error());
            }
            let mut binding = ArtifactBinding {
                registration_id: artifact.registration_id,
                artifact_id: Some(artifact.id.clone()),
                local_path: normalize_destination(&path).map_err(tool_error)?,
                content_hash: content_hash(&artifact.content),
            };
            bindings
                .validate_destination(&self.0.workspace_root, &binding)
                .await
                .map_err(tool_error)?;
            bindings.bind(binding.clone()).map_err(tool_error)?;
            binding.local_path = save_new_file(&self.0.workspace_root, &path, &artifact.content)
                .await
                .map_err(tool_error)?;
            let output = bound_artifact(&self.0, &artifact.id, &binding.local_path);
            bindings.bind(binding).map_err(tool_error)?;
            bindings.persist().await.map_err(tool_error)?;
            Ok(output)
        })
        .await
    }
}

impl rig::tool::Tool for ListArtifactsTool {
    const NAME: &'static str = "list_artifacts";
    type Error = ToolExecutionError;
    type Args = ListArtifactsArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "List the project's artifacts. Ones bound on this machine include their `path`.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(ListArtifactsArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        _args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&_args).map_err(|error| tool_error(error.into()))?;
        execute_tool_job(
            &self.0,
            Self::NAME,
            payload,
            |cancellation| async move {
                let bindings = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Err(cancelled_error()),
                    result = self.0.artifact_bindings.snapshot() => result.map_err(tool_error)?,
                };
                for _ in 0..3 {
                    let mut cursor: Option<String> = None;
                    let mut revision = None;
                    let mut artifacts = Vec::new();
                    loop {
                        let args = mutation_args_from_payload(&self.0.run_id, &self.0.claim_id, &json!({"cursor": cursor}))?;
                        let page = tokio::select! {
                            biased;
                            _ = cancellation.cancelled() => return Err(cancelled_error()),
                            result = self.0.runtime.query_json::<ArtifactPage>("artifacts:listArtifactsForRun", args) => result.map_err(tool_error)?,
                        };
                        if revision.is_some_and(|revision| revision != page.revision) { break; }
                        revision = Some(page.revision);
                        artifacts.extend(page.page.into_iter().map(|artifact| {
                            artifact_summary(artifact, &bindings, &self.0.workspace_root)
                        }));
                        if page.is_done { return Ok(json!({"artifacts": artifacts})); }
                        if cursor.as_ref() == Some(&page.continue_cursor) {
                            return Err(tool_error(anyhow::anyhow!("Artifact page cursor did not advance")));
                        }
                        cursor = Some(page.continue_cursor);
                    }
                }
                Err(tool_error(anyhow::anyhow!("Artifact registry kept changing during listing; retry the tool")))
            },
        ).await
    }
}

impl rig::tool::Tool for DeleteArtifactTool {
    const NAME: &'static str = "delete_artifact";
    type Error = ToolExecutionError;
    type Args = DeleteArtifactArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Delete an artifact and its bound local files.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(DeleteArtifactArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|error| tool_error(error.into()))?;
        let mutation_args = mutation_args_from_payload(&self.0.run_id, &self.0.claim_id, &payload)?;
        execute_tool_job(&self.0, Self::NAME, payload, |cancellation| async move {
            let mut bindings = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(cancelled_error()),
                result = self.0.artifact_bindings.lock() => result.map_err(tool_error)?,
            };
            bindings
                .delete_artifact(&self.0.workspace_root, &args.artifact_id)
                .await
                .map_err(tool_error)?;
            // Keep the store exclusive until Convex removes the artifact so a
            // concurrent save cannot recreate the file from the still-visible record.
            tokio::time::timeout(
                std::time::Duration::from_secs(10),
                run_convex_tool_mutation(
                    &self.0.runtime,
                    cancellation,
                    "artifacts:deleteArtifactForRun",
                    mutation_args,
                ),
            )
            .await
            .map_err(|error| tool_error(error.into()))?
        })
        .await
    }
}

#[cfg(test)]
mod tests;
