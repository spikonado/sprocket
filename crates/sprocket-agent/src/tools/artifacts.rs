use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::{MAX_ARTIFACT_BYTES, WorkspaceCancellation, read_artifact_file};

use super::context::{AgentToolContext, cancelled_error, tool_error};
use super::job::{execute_tool_job, mutation_args_from_payload, run_convex_tool_mutation};
use crate::artifact_bindings::{
    ArtifactBinding, content_hash, normalize_destination, save_new_file,
};

#[derive(Clone)]
pub(crate) struct AddArtifactTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct ListArtifactsTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct EditArtifactTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct SaveArtifactTool(pub(super) AgentToolContext);

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct AddArtifactArgs {
    /// Existing UTF-8 file. Relative paths resolve against the current workspace.
    pub(crate) path: String,
    pub(crate) scope: ArtifactScope,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ArtifactScope {
    Thread,
    Project,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EditArtifactArgs {
    pub(crate) artifact_id: String,
    /// Absolute or workspace-relative file path.
    pub(crate) path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ListArtifactsArgs {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactPage {
    page: Vec<serde_json::Value>,
    is_done: bool,
    continue_cursor: String,
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u64")]
    revision: u64,
}

async fn register_file(
    context: &AgentToolContext,
    cancellation: WorkspaceCancellation,
    function: &str,
    path: &str,
    mut fields: serde_json::Value,
) -> Result<serde_json::Value, ToolExecutionError> {
    let mut bindings = tokio::select! {
        _ = cancellation.cancelled() => return Err(cancelled_error()),
        result = context.artifact_bindings.lock() => result.map_err(tool_error)?,
    };
    let file = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(cancelled_error()),
        result = read_artifact_file(&context.workspace_root, path) => result.map_err(tool_error)?,
    };
    let (registration_id, existing_id, baseline) = if function == "artifacts:addArtifact" {
        let scope = fields["scope"].as_str().unwrap();
        let thread = (scope == "thread").then_some(context.thread_id.as_str());
        let path = bindings
            .at_path(&context.workspace_root, &file.local_path, scope, thread)
            .await
            .map(|binding| binding.local_path)
            .unwrap_or_else(|| file.local_path.clone());
        let binding = bindings.reserve(path, scope, thread);
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
    } else {
        (
            String::new(),
            fields["artifactId"].as_str().map(str::to_string),
            content_hash(&file.content),
        )
    };
    let mut function = function;
    let existing = if let Some(id) = &existing_id {
        let artifact = tokio::select! {
            _ = cancellation.cancelled() => return Err(cancelled_error()),
            result = get_artifact(context, id) => result?,
        };
        fields = json!({"artifactId": id, "expectedRevision": artifact.revision});
        function = "artifacts:editArtifact";
        Some(artifact)
    } else {
        fields["registrationId"] = json!(registration_id);
        None
    };
    let scope = existing
        .as_ref()
        .map(|artifact| artifact.scope.as_str())
        .unwrap_or_else(|| fields["scope"].as_str().unwrap());
    let thread_id = (scope == "thread").then(|| context.thread_id.clone());
    let mut binding = ArtifactBinding {
        registration_id: existing
            .as_ref()
            .map(|artifact| artifact.registration_id.clone())
            .unwrap_or(registration_id),
        artifact_id: existing_id,
        scope: scope.into(),
        thread_id,
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
    fields["contentType"] = json!(file.content_type);
    let mutation_args = mutation_args_from_payload(&context.run_id, &context.claim_id, &fields)?;
    let result =
        run_convex_tool_mutation(&context.runtime, cancellation, function, mutation_args).await?;
    binding.artifact_id = Some(
        result["artifactId"]
            .as_str()
            .ok_or_else(|| tool_error(anyhow::anyhow!("Artifact response has no ID")))?
            .to_string(),
    );
    bindings.bind(binding).map_err(tool_error)?;
    bindings.persist().await.map_err(tool_error)?;
    Ok(artifact_summary(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredArtifact {
    #[serde(rename = "_id")]
    id: String,
    registration_id: String,
    scope: String,
    thread_id: Option<String>,
    content: String,
    title: String,
    #[serde(rename = "type")]
    content_type: String,
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u64")]
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

fn artifact_summary(artifact: serde_json::Value) -> serde_json::Value {
    let Some(fields) = artifact.as_object() else {
        return artifact;
    };
    let mut summary = serde_json::Map::new();
    if let Some(id) = fields.get("artifactId").or_else(|| fields.get("_id")) {
        summary.insert("artifactId".to_string(), id.clone());
    }
    for key in [
        "scope",
        "repositoryKey",
        "threadId",
        "title",
        "type",
        "contentType",
        "revision",
        "createdAt",
        "updatedAt",
    ] {
        if let Some(value) = fields.get(key) {
            summary.insert(key.to_string(), value.clone());
        }
    }
    serde_json::Value::Object(summary)
}

impl rig::tool::Tool for AddArtifactTool {
    const NAME: &'static str = "add_artifact";
    type Error = ToolExecutionError;
    type Args = AddArtifactArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        format!(
            "Register an existing local file as a thread or project artifact. Write the file first with normal file tools. HTML and JSX render as previews; other UTF-8 files render as Markdown. File changes sync automatically. Maximum file size: {MAX_ARTIFACT_BYTES} bytes."
        )
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(AddArtifactArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|error| tool_error(error.into()))?;
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| async move {
                register_file(
                    &self.0,
                    cancellation,
                    "artifacts:addArtifact",
                    &args.path,
                    json!({"scope": args.scope}),
                )
                .await
            },
        )
        .await
    }
}

impl rig::tool::Tool for EditArtifactTool {
    const NAME: &'static str = "edit_artifact";
    type Error = ToolExecutionError;
    type Args = EditArtifactArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Point an artifact from the current thread or project at a different existing file. To edit its content, edit the registered file normally instead.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(EditArtifactArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|error| tool_error(error.into()))?;
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| async move {
                register_file(
                    &self.0,
                    cancellation,
                    "artifacts:editArtifact",
                    &args.path,
                    json!({"artifactId": args.artifact_id}),
                )
                .await
            },
        )
        .await
    }
}

impl rig::tool::Tool for SaveArtifactTool {
    const NAME: &'static str = "save_artifact";
    type Error = ToolExecutionError;
    type Args = EditArtifactArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Save an artifact from this thread or project to an absolute or workspace-relative file path, and bind the file so future edits sync. Existing files with different contents are never overwritten.".into()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(EditArtifactArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|error| tool_error(error.into()))?;
        execute_tool_job(&self.0.runtime, &self.0.run_id, &self.0.claim_id, Self::NAME,
            &self.0.tool_call_tracker, payload, |cancellation| async move {
                let mut bindings = tokio::select! {
                    _ = cancellation.cancelled() => return Err(cancelled_error()),
                    result = self.0.artifact_bindings.lock() => result.map_err(tool_error)?,
                };
                let artifact = tokio::select! {
                    _ = cancellation.cancelled() => return Err(cancelled_error()),
                    result = get_artifact(&self.0, &args.artifact_id) => result?,
                };
                if cancellation.is_cancelled() { return Err(cancelled_error()); }
                let mut binding = ArtifactBinding {
                    registration_id: artifact.registration_id,
                    artifact_id: Some(artifact.id.clone()), scope: artifact.scope.clone(),
                    thread_id: artifact.thread_id,
                    local_path: normalize_destination(&args.path).map_err(tool_error)?, content_hash: content_hash(&artifact.content),
                };
                bindings.validate_destination(&self.0.workspace_root, &binding).await.map_err(tool_error)?;
                bindings.bind(binding.clone()).map_err(tool_error)?;
                binding.local_path = save_new_file(&self.0.workspace_root, &args.path, &artifact.content).await.map_err(tool_error)?;
                bindings.bind(binding).map_err(tool_error)?;
                bindings.persist().await.map_err(tool_error)?;
                Ok(json!({"artifactId": artifact.id, "revision": artifact.revision, "title": artifact.title,
                    "contentType": artifact.content_type, "scope": artifact.scope}))
            }).await
    }
}

impl rig::tool::Tool for ListArtifactsTool {
    const NAME: &'static str = "list_artifacts";
    type Error = ToolExecutionError;
    type Args = ListArtifactsArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "List artifact IDs and metadata for the current thread and project. Use save_artifact to obtain a local file for an artifact that is not saved on this machine.".to_string()
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
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| async move {
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
                        artifacts.extend(page.page);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summaries_keep_file_identity_without_copying_content_into_tool_history() {
        assert_eq!(
            artifact_summary(json!({
                "_id": "id",
                "content": "large body",
                "userId": "user",
                "threadId": "thread",
                "type": "markdown",
                "title": "doc.md",
                "revision": 3,
                "_creationTime": 1,
                "localPath": "doc.md",
                "scope": "project"
            })),
            json!({"artifactId": "id", "scope": "project", "threadId": "thread", "type": "markdown", "title": "doc.md", "revision": 3})
        );
        assert_eq!(
            artifact_summary(json!({
                "artifactId": "id",
                "revision": 2,
                "title": "doc.md",
                "contentType": "markdown",
                "localPath": "doc.md",
                "scope": "thread",
                "content": "body"
            })),
            json!({"artifactId": "id", "scope": "thread", "title": "doc.md", "revision": 2, "contentType": "markdown"})
        );
    }
}
