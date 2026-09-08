use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::{MAX_ARTIFACT_BYTES, WorkspaceCancellation, read_artifact_file};

use super::context::{AgentToolContext, cancelled_error, tool_error};
use super::job::{execute_tool_job, mutation_args_from_payload, run_convex_tool_mutation};

#[derive(Clone)]
pub(crate) struct AddArtifactTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct ListArtifactsTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct EditArtifactTool(pub(super) AgentToolContext);

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
    /// New existing file path. This changes the registration, not the file itself.
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
    let file = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(cancelled_error()),
        result = read_artifact_file(&context.workspace_root, path) => result.map_err(tool_error)?,
    };
    fields["localPath"] = json!(file.local_path);
    fields["content"] = json!(file.content);
    fields["title"] = json!(file.title);
    fields["contentType"] = json!(file.content_type);
    let mutation_args = mutation_args_from_payload(&context.run_id, &context.claim_id, &fields)?;
    let result =
        run_convex_tool_mutation(&context.runtime, cancellation, function, mutation_args).await?;
    Ok(artifact_summary(result))
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
        "localPath",
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

impl rig::tool::Tool for ListArtifactsTool {
    const NAME: &'static str = "list_artifacts";
    type Error = ToolExecutionError;
    type Args = ListArtifactsArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "List artifact IDs, paths, and scopes for the current thread and project. Read or edit their files with normal file tools.".to_string()
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
    fn registration_args_are_path_scope_only() {
        assert!(
            serde_json::from_value::<AddArtifactArgs>(
                json!({"path": "doc.md", "scope": "thread", "content": "inline"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<AddArtifactArgs>(json!({"path": "doc.md", "scope": "global"}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<EditArtifactArgs>(
                json!({"artifactId": "id", "path": "doc.md", "content": "inline"})
            )
            .is_err()
        );
        assert!(serde_json::from_value::<ListArtifactsArgs>(json!({"path": "doc.md"})).is_err());
        let add: AddArtifactArgs =
            serde_json::from_value(json!({"path": "doc.md", "scope": "thread"})).unwrap();
        assert_eq!(
            serde_json::to_value(&add).unwrap(),
            json!({"path": "doc.md", "scope": "thread"})
        );
        let edit: EditArtifactArgs =
            serde_json::from_value(json!({"artifactId": "id", "path": "/tmp/new.md"})).unwrap();
        assert_eq!(
            serde_json::to_value(&edit).unwrap(),
            json!({"artifactId": "id", "path": "/tmp/new.md"})
        );
        assert_eq!(
            serde_json::to_value(&ListArtifactsArgs {}).unwrap(),
            json!({})
        );
    }

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
            json!({"artifactId": "id", "localPath": "doc.md", "scope": "project", "threadId": "thread", "type": "markdown", "title": "doc.md", "revision": 3})
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
            json!({"artifactId": "id", "localPath": "doc.md", "scope": "thread", "title": "doc.md", "revision": 2, "contentType": "markdown"})
        );
    }
}
