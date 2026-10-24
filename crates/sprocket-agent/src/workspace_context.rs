use std::path::Path;

use rig::completion::Message;
use serde::Serialize;
use sprocket_transcript::HiddenPromptKind;
use sprocket_workspace::{WorkspaceInstruction, WorkspaceInstructionSource, WorkspaceSkill};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct HiddenPrompt {
    pub(crate) kind: HiddenPromptKind,
    pub(crate) text: String,
}

impl HiddenPrompt {
    pub(crate) fn message(&self) -> Message {
        Message::user(self.text.clone())
    }
}

/// The workspace context read from this machine, rendered for any cwd.
pub(crate) struct WorkspaceContext {
    instructions: String,
    location: String,
}

impl WorkspaceContext {
    pub(crate) fn new(
        workspace_instructions: &[WorkspaceInstruction],
        skills: &[WorkspaceSkill],
        thread_id: &str,
        transcript_dir: &Path,
        workspace_root: &Path,
    ) -> Self {
        Self {
            instructions: format!(
                "# Workspace instructions\n\n## Available skills\n\n{}\n\n## Preloaded AGENTS.md instructions\n\n{}",
                skills_section(skills),
                instructions_section(workspace_instructions)
            ),
            location: format!(
                "# Environment\n\n- This conversation/thread's ID is {thread_id}. Thread transcripts and attachments are stored in `{}`.\n- The workspace root is `{}`.",
                transcript_dir.display(),
                workspace_root.display()
            ),
        }
    }

    pub(crate) fn prompts(&self, cwd: &Path) -> [HiddenPrompt; 2] {
        [
            HiddenPrompt {
                kind: HiddenPromptKind::Instructions,
                text: self.instructions.clone(),
            },
            HiddenPrompt {
                kind: HiddenPromptKind::Environment,
                text: format!(
                    "{}\n- Relative paths in tools resolve from the current working directory `{}`. Use set_cwd to change it.",
                    self.location,
                    cwd.display()
                ),
            },
        ]
    }
}

/// The live prompts whose kind the model last saw with different text, or not
/// at all. Sending only these keeps every earlier message unchanged.
pub(crate) fn unseen(shown: &[HiddenPrompt], live: [HiddenPrompt; 2]) -> Vec<HiddenPrompt> {
    live.into_iter()
        .filter(|live| {
            shown
                .iter()
                .rev()
                .find(|prompt| prompt.kind == live.kind)
                .is_none_or(|prompt| prompt.text != live.text)
        })
        .collect()
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
