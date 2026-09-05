use std::sync::Arc;

use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::{WorkspaceSkill, read_skill_content};

use super::context::{AgentToolContext, tool_error, tool_failure};
use super::job::execute_tool_job;

#[derive(Clone)]
pub(crate) struct ReadSkillTool {
    pub(super) context: AgentToolContext,
    pub(super) skills: Arc<[WorkspaceSkill]>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct ReadSkillArgs {
    /// Skill name from the Skills section of the system instructions.
    pub(crate) name: String,
}

impl rig::tool::Tool for ReadSkillTool {
    const NAME: &'static str = "read_skill";
    type Error = ToolExecutionError;
    type Args = ReadSkillArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Read a skill's SKILL.md instructions by name. Use when a task matches a skill listed in the Skills section of your instructions."
            .to_string()
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
        execute_tool_job(
            &self.context.runtime,
            &self.context.run_id,
            &self.context.claim_id,
            Self::NAME,
            &self.context.tool_call_tracker,
            payload,
            |_cancellation| async move {
                let output = resolve_read_skill(&skills, &args.name)?;
                Ok(output)
            },
        )
        .await
    }
}

pub(super) fn resolve_read_skill(
    skills: &[WorkspaceSkill],
    name: &str,
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

    let content = read_skill_content(skill).map_err(|e| tool_error(anyhow::Error::msg(e)))?;
    let mut value = json!({
        "name": content.name,
        "description": content.description,
        "content": content.content,
    });
    if let Some(dir) = content.dir {
        value["dir"] = json!(dir);
    }
    if content.truncated {
        value["truncated"] = json!(true);
    }
    Ok(value)
}
