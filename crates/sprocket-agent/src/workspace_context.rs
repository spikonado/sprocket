use std::path::Path;

use rig::completion::Message;
use serde::{Deserialize, Serialize};
use sprocket_workspace::{WorkspaceInstruction, WorkspaceInstructionSource, WorkspaceSkill};

use crate::types::{AgentHistoryContent, AgentHistoryMessage, AgentHistoryRole};

/// Rendered sections of the workspace context message. Updates recorded after
/// the first message hold only the sections that changed, so the model keeps
/// the earlier ones and the request prefix stays the same.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
}

/// What Convex recorded for the thread's current history.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedWorkspaceContext {
    /// Written with the current context handoff and shown before its summary.
    #[serde(default)]
    pub base: Option<WorkspaceContext>,
    /// Shown before the first turn of their run, oldest first.
    #[serde(default)]
    pub updates: Vec<WorkspaceContextUpdate>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContextUpdate {
    pub run_id: String,
    pub context: WorkspaceContext,
}

impl WorkspaceContext {
    /// The sections of `live` the model has not seen yet.
    pub(crate) fn changes_to(&self, live: &WorkspaceContext) -> Option<WorkspaceContext> {
        let unseen =
            |shown: &Option<String>, live: &Option<String>| live.clone().filter(|_| shown != live);
        let changes = WorkspaceContext {
            skills: unseen(&self.skills, &live.skills),
            instructions: unseen(&self.instructions, &live.instructions),
            environment: unseen(&self.environment, &live.environment),
        };
        (changes != WorkspaceContext::default()).then_some(changes)
    }

    pub(crate) fn apply(&mut self, update: &WorkspaceContext) {
        for (shown, changed) in [
            (&mut self.skills, &update.skills),
            (&mut self.instructions, &update.instructions),
            (&mut self.environment, &update.environment),
        ] {
            if changed.is_some() {
                shown.clone_from(changed);
            }
        }
    }

    pub(crate) fn text(&self) -> String {
        let complete =
            self.skills.is_some() && self.instructions.is_some() && self.environment.is_some();
        let mut blocks = vec![if complete {
            "# Workspace context".to_string()
        } else {
            "# Workspace context update\n\nThese sections replace the ones shown earlier."
                .to_string()
        }];
        for (heading, section) in [
            ("## Available skills", &self.skills),
            ("## Preloaded AGENTS.md instructions", &self.instructions),
            ("## Environment", &self.environment),
        ] {
            if let Some(section) = section {
                blocks.push(format!("{heading}\n\n{section}"));
            }
        }
        blocks.join("\n\n")
    }

    pub(crate) fn message(&self) -> Message {
        Message::user(self.text())
    }

    pub(crate) fn history_message(&self) -> AgentHistoryMessage {
        AgentHistoryMessage {
            role: AgentHistoryRole::User,
            origin: None,
            contents: vec![AgentHistoryContent::Text {
                text: self.text(),
                native_item: None,
            }],
        }
    }
}

/// The workspace context read from this machine, rendered for any cwd.
pub(crate) struct LiveWorkspaceContext {
    skills: String,
    instructions: String,
    location: String,
}

impl LiveWorkspaceContext {
    pub(crate) fn new(
        workspace_instructions: &[WorkspaceInstruction],
        skills: &[WorkspaceSkill],
        thread_id: &str,
        transcript_dir: &Path,
        workspace_root: &Path,
    ) -> Self {
        Self {
            skills: skills_section(skills),
            instructions: instructions_section(workspace_instructions),
            location: format!(
                "- This conversation/thread's ID is {thread_id}. Thread transcripts and attachments are stored in `{}`.\n- The workspace root is `{}`.",
                transcript_dir.display(),
                workspace_root.display()
            ),
        }
    }

    pub(crate) fn at(&self, cwd: &Path) -> WorkspaceContext {
        WorkspaceContext {
            skills: Some(self.skills.clone()),
            instructions: Some(self.instructions.clone()),
            environment: Some(format!(
                "{}\n- Relative paths in tools resolve from the current working directory `{}`. Use set_cwd to change it.",
                self.location,
                cwd.display()
            )),
        }
    }
}

fn skills_section(skills: &[WorkspaceSkill]) -> String {
    let entries = skills
        .iter()
        .filter(|skill| !skill.disable_model_invocation)
        .map(|skill| {
            let description = collapse_whitespace(&skill.description);
            format!("- name: {}\n  description: {description}", skill.name)
        })
        .collect::<Vec<_>>();
    if entries.is_empty() {
        "No skills are installed.".to_string()
    } else {
        format!("<SKILLS>\n{}\n</SKILLS>", entries.join("\n"))
    }
}

fn instructions_section(workspace_instructions: &[WorkspaceInstruction]) -> String {
    let contents = |source: WorkspaceInstructionSource| {
        workspace_instructions
            .iter()
            .filter(|instruction| instruction.source == source)
            .map(|instruction| instruction.contents.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let blocks = [
        (
            "The user's AGENTS.md",
            contents(WorkspaceInstructionSource::User),
        ),
        (
            "The workspace root's AGENTS.md",
            contents(WorkspaceInstructionSource::Workspace),
        ),
    ]
    .into_iter()
    .filter(|(_, contents)| !contents.is_empty())
    .map(|(heading, contents)| {
        format!("### {heading}\n<INSTRUCTIONS>\n{contents}\n</INSTRUCTIONS>")
    })
    .collect::<Vec<_>>();
    if blocks.is_empty() {
        "No AGENTS.md instructions were preloaded for the current workspace.".to_string()
    } else {
        blocks.join("\n\n")
    }
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests;
