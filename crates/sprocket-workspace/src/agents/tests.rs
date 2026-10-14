use std::fs;

use super::{WorkspaceInstructionSource, load_workspace_instructions_from};

fn temp_path(prefix: &str) -> std::path::PathBuf {
    crate::test_support::temp_workspace_labeled(prefix)
}

#[test]
fn loads_instructions_from_project_root_to_cwd() {
    let root = temp_path("sprocket-instructions");
    let nested = root.join("packages/app");
    fs::create_dir_all(&nested).expect("nested dir should be created");
    gix::init(&root).expect("git repository should be created");
    fs::write(root.join("AGENTS.md"), "root instructions").expect("root instructions");
    fs::write(nested.join("AGENTS.md"), "nested instructions").expect("nested instructions");

    let instructions =
        load_workspace_instructions_from(&nested, None).expect("instructions should load");

    assert_eq!(instructions.len(), 2);
    assert_eq!(instructions[0].contents, "root instructions");
    assert_eq!(instructions[1].contents, "nested instructions");

    fs::remove_dir_all(root).expect("temp workspace should be removed");
}

#[test]
fn loads_user_instructions_before_workspace_instructions() {
    let root = temp_path("sprocket-user-instructions");
    let user_home = temp_path("sprocket-user-home");
    fs::create_dir_all(user_home.join(".agents")).expect("user agents dir");
    gix::init(&root).expect("git repository should be created");
    fs::write(user_home.join(".agents/AGENTS.md"), "user instructions").expect("user instructions");
    fs::write(root.join("AGENTS.md"), "workspace instructions").expect("workspace instructions");

    let instructions = load_workspace_instructions_from(&root, Some(&user_home))
        .expect("instructions should load");

    assert_eq!(instructions.len(), 2);
    assert_eq!(instructions[0].source, WorkspaceInstructionSource::User);
    assert_eq!(instructions[0].contents, "user instructions");
    assert_eq!(
        instructions[1].source,
        WorkspaceInstructionSource::Workspace
    );
    assert_eq!(instructions[1].contents, "workspace instructions");

    fs::remove_dir_all(root).expect("temp workspace should be removed");
    fs::remove_dir_all(user_home).expect("temp user home should be removed");
}

#[test]
fn user_instructions_do_not_consume_workspace_instruction_budget() {
    let root = temp_path("sprocket-user-instruction-budget");
    let user_home = temp_path("sprocket-user-budget-home");
    fs::create_dir_all(user_home.join(".agents")).expect("user agents dir");
    gix::init(&root).expect("git repository should be created");
    fs::write(
        user_home.join(".agents/AGENTS.md"),
        "u".repeat(super::MAX_INSTRUCTION_BYTES),
    )
    .expect("user instructions");
    fs::write(root.join("AGENTS.md"), "workspace instructions").expect("workspace instructions");

    let instructions = load_workspace_instructions_from(&root, Some(&user_home))
        .expect("instructions should load");

    assert_eq!(instructions.len(), 2);
    assert_eq!(instructions[0].source, WorkspaceInstructionSource::User);
    assert_eq!(
        instructions[1].source,
        WorkspaceInstructionSource::Workspace
    );
    assert_eq!(instructions[1].contents, "workspace instructions");

    fs::remove_dir_all(root).expect("temp workspace should be removed");
    fs::remove_dir_all(user_home).expect("temp user home should be removed");
}

#[test]
fn ignores_agents_override_files() {
    let root = temp_path("sprocket-instructions-override");
    fs::create_dir_all(&root).expect("root dir should be created");
    gix::init(&root).expect("git repository should be created");
    fs::write(root.join("AGENTS.md"), "workspace instructions").expect("workspace instructions");
    fs::write(root.join("AGENTS.override.md"), "override").expect("override file");

    let instructions =
        load_workspace_instructions_from(&root, None).expect("instructions should load");

    assert_eq!(instructions.len(), 1);
    assert_eq!(instructions[0].contents, "workspace instructions");

    fs::remove_dir_all(root).expect("temp workspace should be removed");
}

#[test]
fn only_reads_cwd_when_no_project_root_marker_exists() {
    let root = temp_path("sprocket-instructions-no-marker");
    let nested = root.join("packages/app");
    fs::create_dir_all(&nested).expect("nested dir should be created");
    fs::write(root.join("AGENTS.md"), "root instructions").expect("root instructions");
    fs::write(nested.join("AGENTS.md"), "nested instructions").expect("nested instructions");

    let instructions =
        load_workspace_instructions_from(&nested, None).expect("instructions should load");

    assert_eq!(instructions.len(), 1);
    assert_eq!(instructions[0].contents, "nested instructions");

    fs::remove_dir_all(root).expect("temp workspace should be removed");
}
