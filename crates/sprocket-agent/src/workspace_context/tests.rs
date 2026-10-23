use std::path::Path;

use sprocket_workspace::{
    SkillSource, WorkspaceInstruction, WorkspaceInstructionSource, WorkspaceSkill,
};

use super::{LiveWorkspaceContext, WorkspaceContext};

fn rendered(instructions: &[WorkspaceInstruction], skills: &[WorkspaceSkill]) -> String {
    LiveWorkspaceContext::new(
        instructions,
        skills,
        "thread-id",
        Path::new("/data/transcripts/user/thread-id"),
        Path::new("/tmp/project"),
    )
    .at(Path::new("/tmp/project/app"))
    .text()
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
    let text = rendered(
        &[],
        &[
            skill("pdf-processing", "Handle\nPDFs", false),
            skill("deploy", "Deploy production", true),
        ],
    );
    assert!(text.starts_with("# Workspace context\n"));
    assert!(
        text.contains("<SKILLS>\n- name: pdf-processing\n  description: Handle PDFs\n</SKILLS>")
    );
    assert!(!text.contains("deploy"));

    let text = rendered(&[], &[skill("deploy", "Deploy production", true)]);
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
    let text = rendered(
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
fn updates_hold_only_changed_sections() {
    let live = LiveWorkspaceContext::new(&[], &[], "thread", Path::new("/t"), Path::new("/repo"));
    let mut shown = WorkspaceContext::default();
    let full = shown.changes_to(&live.at(Path::new("/repo"))).unwrap();
    shown.apply(&full);
    assert_eq!(shown.changes_to(&live.at(Path::new("/repo"))), None);

    let update = shown.changes_to(&live.at(Path::new("/repo/app"))).unwrap();
    assert_eq!(
        (update.skills.as_ref(), update.instructions.as_ref()),
        (None, None)
    );
    assert!(
        update
            .text()
            .starts_with("# Workspace context update\n\nThese sections replace the ones shown earlier.\n\n## Environment\n\n")
    );
}
