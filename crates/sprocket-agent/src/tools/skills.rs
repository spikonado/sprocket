use std::ffi::OsString;
use std::path::Path;
use std::sync::Arc;

use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::{WorkspaceCancellation, WorkspaceSkill, read_skill_content};

use super::context::{AgentToolContext, tool_error, tool_failure};
use super::job::execute_tool_job;

#[derive(Clone)]
pub(crate) struct ReadSkillTool {
    pub(super) context: AgentToolContext,
    pub(super) skills: Arc<[WorkspaceSkill]>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct ReadSkillArgs {
    pub(crate) name: String,
}

impl rig::tool::Tool for ReadSkillTool {
    const NAME: &'static str = "read_skill";
    type Error = ToolExecutionError;
    type Args = ReadSkillArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        String::new()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(ReadSkillArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        let skills = self.skills.clone();
        let cwd = self.context.cwd.get();
        let environment = self.context.command_sessions.environment();
        execute_tool_job(
            &self.context,
            Self::NAME,
            payload,
            |cancellation| async move {
                resolve_read_skill(&skills, &args.name, &cwd, environment, &cancellation).await
            },
        )
        .await
    }
}

pub(super) async fn resolve_read_skill(
    skills: &[WorkspaceSkill],
    name: &str,
    cwd: &Path,
    environment: &[(OsString, OsString)],
    cancellation: &WorkspaceCancellation,
) -> Result<serde_json::Value, ToolExecutionError> {
    let Some(skill) = skills.iter().find(|skill| skill.name == name) else {
        let available = if skills.is_empty() {
            "(none)".to_string()
        } else {
            skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        };
        return Err(tool_failure(format!(
            "Unknown skill '{name}'. Available skills: {available}"
        )));
    };

    let content = read_skill_content(skill, cwd, environment, cancellation)
        .await
        .map_err(tool_error)?;
    let mut value = json!({
        "name": content.name,
        "description": content.description,
        "content": content.content,
    });
    if let Some(dir) = content.dir {
        value["dir"] = json!(dir);
    }
    Ok(value)
}
