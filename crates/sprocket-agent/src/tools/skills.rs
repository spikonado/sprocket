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
    pub(super) invocations: SkillInvocations,
}

#[derive(Clone, Default)]
pub(crate) struct SkillInvocations {
    names: Arc<[String]>,
}

impl SkillInvocations {
    pub(crate) fn from_run_prompt(
        skills: &[WorkspaceSkill],
        prompt: &str,
        prompt_is_user: bool,
    ) -> Self {
        if prompt_is_user {
            Self::from_user_prompt(skills, prompt)
        } else {
            Self::default()
        }
    }

    // Only the request's raw user prompt grants access, never model history or a handoff.
    fn from_user_prompt(skills: &[WorkspaceSkill], prompt: &str) -> Self {
        let names = skills
            .iter()
            .filter(|skill| {
                prompt.match_indices('$').any(|(index, _)| {
                    let before = prompt[..index].chars().next_back();
                    if before.is_some_and(|ch| {
                        !ch.is_whitespace() && !matches!(ch, '(' | '[' | '{' | '`' | '\'' | '"')
                    }) {
                        return false;
                    }
                    let Some(after) = prompt[index + 1..].strip_prefix(&skill.name) else {
                        return false;
                    };
                    after.chars().next().is_none_or(|ch| {
                        ch.is_whitespace()
                            || matches!(
                                ch,
                                '.' | ','
                                    | ';'
                                    | ':'
                                    | '!'
                                    | '?'
                                    | ')'
                                    | ']'
                                    | '}'
                                    | '`'
                                    | '\''
                                    | '"'
                            )
                    })
                })
            })
            .map(|skill| skill.name.clone())
            .collect::<Vec<_>>();
        Self {
            names: names.into(),
        }
    }

    fn allows(&self, skill: &WorkspaceSkill) -> bool {
        !skill.disable_model_invocation || self.names.iter().any(|name| name == &skill.name)
    }

    pub(crate) fn load_context(
        &self,
        skills: &[WorkspaceSkill],
    ) -> Result<Vec<rig::completion::Message>, ToolExecutionError> {
        skills
            .iter()
            .filter(|skill| skill.disable_model_invocation && self.allows(skill))
            .map(|skill| {
                let content = resolve_read_skill(skills, self, &skill.name)?;
                Ok(rig::completion::Message::user(format!(
                    "# Explicitly invoked skill\n\n{content}"
                )))
            })
            .collect()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct ReadSkillArgs {
    /// Skill name from Available Skills or an explicit user $skill-name invocation.
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
        let invocations = self.invocations.clone();
        execute_tool_job(
            &self.context,
            Self::NAME,
            payload,
            |_cancellation| async move {
                let output = resolve_read_skill(&skills, &invocations, &args.name)?;
                Ok(output)
            },
        )
        .await
    }
}

pub(super) fn resolve_read_skill(
    skills: &[WorkspaceSkill],
    invocations: &SkillInvocations,
    name: &str,
) -> Result<serde_json::Value, ToolExecutionError> {
    let Some(skill) = skills.iter().find(|skill| skill.name == name) else {
        let available = skills
            .iter()
            .filter(|skill| invocations.allows(skill))
            .map(|skill| skill.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let available = if available.is_empty() {
            "(none)"
        } else {
            &available
        };
        return Err(tool_failure(format!(
            "Unknown skill '{name}'. Available skills: {available}"
        )));
    };

    if !invocations.allows(skill) {
        return Err(ToolExecutionError::permission_denied(format!(
            "Skill '{name}' requires an explicit user ${name} invocation in the current request."
        )));
    }

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

#[cfg(test)]
mod tests {
    use sprocket_workspace::SkillSource;

    use super::*;

    fn skills() -> [WorkspaceSkill; 3] {
        [
            WorkspaceSkill {
                name: "deploy".to_string(),
                description: "Deploy production".to_string(),
                disable_model_invocation: true,
                source: SkillSource::BuiltIn {
                    contents: "---\nname: deploy\ndescription: Deploy production\ndisable-model-invocation: true\n---\n# Deploy instructions\n",
                },
            },
            WorkspaceSkill {
                name: "release".to_string(),
                description: "Release production".to_string(),
                disable_model_invocation: true,
                source: SkillSource::BuiltIn { contents: "" },
            },
            WorkspaceSkill {
                name: "ordinary".to_string(),
                description: "Ordinary skill".to_string(),
                disable_model_invocation: false,
                source: SkillSource::BuiltIn {
                    contents: "---\nname: ordinary\ndescription: Ordinary skill\n---\n# Ordinary instructions\n",
                },
            },
        ]
    }

    #[test]
    fn model_reads_require_the_matching_explicit_invocation() {
        let skills = skills();
        let unprompted = SkillInvocations::from_user_prompt(&skills, "Deploy the app");
        let error = resolve_read_skill(&skills, &unprompted, "deploy").unwrap_err();
        assert!(
            error
                .to_string()
                .contains("requires an explicit user $deploy")
        );
        assert!(unprompted.load_context(&skills).unwrap().is_empty());
        assert_eq!(
            resolve_read_skill(&skills, &unprompted, "ordinary").unwrap()["content"],
            "# Ordinary instructions\n"
        );

        let invoked = SkillInvocations::from_user_prompt(&skills, "Use $deploy now");
        assert_eq!(
            resolve_read_skill(&skills, &invoked, "deploy").unwrap()["content"],
            "# Deploy instructions\n"
        );
        assert_eq!(invoked.load_context(&skills).unwrap().len(), 1);
        assert!(resolve_read_skill(&skills, &invoked, "release").is_err());

        let next_request = SkillInvocations::from_user_prompt(&skills, "Review the result");
        assert!(resolve_read_skill(&skills, &next_request, "deploy").is_err());
    }

    #[test]
    fn explicit_invocations_match_complete_skill_names() {
        let skills = skills();
        for prompt in [
            "$deploy",
            "Use $deploy.",
            "Use ($deploy)",
            "Use `$deploy`",
            "$deploy\n",
        ] {
            let invoked = SkillInvocations::from_user_prompt(&skills, prompt);
            assert!(
                resolve_read_skill(&skills, &invoked, "deploy").is_ok(),
                "{prompt}"
            );
        }
        for prompt in [
            "deploy",
            "$deployer",
            "$deploy-other",
            "$deploy/path",
            "prefix$deploy",
            "\\$deploy",
            "$$deploy",
            "$DEPLOY",
            "$deploy_other",
        ] {
            let invoked = SkillInvocations::from_user_prompt(&skills, prompt);
            assert!(
                resolve_read_skill(&skills, &invoked, "deploy").is_err(),
                "{prompt}"
            );
        }
    }

    #[test]
    fn unknown_skill_errors_only_list_authorized_names() {
        let skills = skills();
        let error = resolve_read_skill(&skills, &SkillInvocations::default(), "missing")
            .unwrap_err()
            .to_string();
        assert!(error.contains("Available skills: ordinary"));
        let invoked = SkillInvocations::from_user_prompt(&skills, "$deploy");
        let error = resolve_read_skill(&skills, &invoked, "missing")
            .unwrap_err()
            .to_string();
        assert!(error.contains("Available skills: deploy, ordinary"));
    }

    #[test]
    fn blocked_reads_fail_before_opening_the_skill_file() {
        let skill = WorkspaceSkill {
            name: "deploy".to_string(),
            description: "Deploy production".to_string(),
            disable_model_invocation: true,
            source: SkillSource::File {
                skill_md_path: std::path::PathBuf::from("/nonexistent/deploy/SKILL.md"),
            },
        };
        let error = resolve_read_skill(&[skill], &SkillInvocations::default(), "deploy")
            .unwrap_err()
            .to_string();
        assert!(error.contains("requires an explicit user $deploy"));
    }

    #[test]
    fn model_generated_delegation_prompts_do_not_authorize_skills() {
        let skills = skills();
        let delegated = SkillInvocations::from_run_prompt(&skills, "Use $deploy", false);
        assert!(resolve_read_skill(&skills, &delegated, "deploy").is_err());
        assert!(delegated.load_context(&skills).unwrap().is_empty());
        let user = SkillInvocations::from_run_prompt(&skills, "Use $deploy", true);
        assert_eq!(user.load_context(&skills).unwrap().len(), 1);
    }

    #[test]
    fn explicit_file_invocation_uses_discovery_precedence_and_capped_reader() {
        let root = tempfile::tempdir().unwrap();
        let project_skill = root.path().join(".sprocket/skills/deploy");
        std::fs::create_dir_all(&project_skill).unwrap();
        std::fs::write(
            project_skill.join("SKILL.md"),
            format!(
                "---\nname: deploy\ndescription: Project deployment\ndisable-model-invocation: true\n---\n{}",
                "p".repeat(70 * 1024)
            ),
        ).unwrap();
        let loaded = sprocket_workspace::load_workspace_skills(
            root.path(),
            &[],
            &[(
                "deploy",
                "---\nname: deploy\ndescription: Built-in deployment\n---\nbuiltin body",
            )],
        );
        assert!(loaded.warnings.is_empty());
        let invocations = SkillInvocations::from_run_prompt(&loaded.skills, "$deploy", true);
        let value = resolve_read_skill(&loaded.skills, &invocations, "deploy").unwrap();
        assert_eq!(value["description"], "Project deployment");
        assert_eq!(value["dir"], project_skill.to_string_lossy().as_ref());
        assert_eq!(value["truncated"], true);
        assert!(value["content"].as_str().unwrap().len() <= 64 * 1024);
        let context = invocations.load_context(&loaded.skills).unwrap();
        assert_eq!(context.len(), 1);
        assert!(
            serde_json::to_string(&context)
                .unwrap()
                .contains("Project deployment")
        );
    }
}
