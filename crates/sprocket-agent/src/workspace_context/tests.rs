use std::path::Path;

use sprocket_workspace::{
    SkillSource, WorkspaceInstruction, WorkspaceInstructionSource, WorkspaceSkill,
};

use super::{WorkspaceContext, unseen};

fn context(instructions: &[WorkspaceInstruction], skills: &[WorkspaceSkill]) -> WorkspaceContext {
    WorkspaceContext::new(
        instructions,
        skills,
        "thread-id",
        Path::new("/data/transcripts/user/thread-id"),
        Path::new("/tmp/project"),
    )
}

fn instructions_text(instructions: &[WorkspaceInstruction], skills: &[WorkspaceSkill]) -> String {
    let [instructions, _] = context(instructions, skills).prompts(Path::new("/tmp/project"));
    instructions.text
}

fn skill(name: &str, description: &str, disable_model_invocation: bool) -> WorkspaceSkill {
    WorkspaceSkill {
        name: name.to_string(),
        description: description.to_string(),
        disable_model_invocation,
        source: SkillSource::BuiltIn { contents: "" },
    }
}

#[test]
fn renders_skills_for_model_invocation() {
    let text = instructions_text(
        &[],
        &[
            skill("pdf-processing", "Handle\nPDFs", false),
            skill("deploy", "Deploy production", true),
        ],
    );
    assert!(
        text.contains("<SKILLS>\n- name: pdf-processing\n  description: Handle PDFs\n</SKILLS>")
    );
    assert!(!text.contains("deploy"));

    let text = instructions_text(&[], &[skill("deploy", "Deploy production", true)]);
    assert!(text.contains("No skills are installed."));
}

#[test]
fn renders_user_instructions_before_workspace_instructions() {
    let instruction = |source, contents: &str| WorkspaceInstruction {
        path: String::new(),
        directory: String::new(),
        contents: contents.to_string(),
        truncated: false,
        source,
    };
    let text = instructions_text(
        &[
            instruction(WorkspaceInstructionSource::Workspace, "Workspace rule."),
            instruction(WorkspaceInstructionSource::User, "User rule."),
        ],
        &[],
    );
    let user = text
        .find("### The user's AGENTS.md\n<INSTRUCTIONS>\nUser rule.")
        .unwrap();
    let workspace = text
        .find("### The workspace root's AGENTS.md\n<INSTRUCTIONS>\nWorkspace rule.")
        .unwrap();
    assert!(user < workspace);
}

#[test]
fn unseen_holds_only_changed_prompts() {
    let live = context(&[], &[]);
    let full = unseen(&[], live.prompts(Path::new("/tmp/project")));
    assert_eq!(full.len(), 2);
    assert!(unseen(&full, live.prompts(Path::new("/tmp/project"))).is_empty());

    let [_, moved] = live.prompts(Path::new("/tmp/project/app"));
    assert_eq!(
        unseen(&full, live.prompts(Path::new("/tmp/project/app"))),
        [moved]
    );
}
