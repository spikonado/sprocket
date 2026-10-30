use super::*;

#[test]
fn finds_the_nearest_package_inside_the_workspace() {
    let workspace = tempfile::tempdir().unwrap();
    let root = workspace.path().canonicalize().unwrap();
    std::fs::write(root.join("package.json"), "{}").unwrap();
    std::fs::create_dir_all(root.join("boards/main/src")).unwrap();
    std::fs::write(root.join("boards/main/package.json"), "{}").unwrap();
    std::fs::write(root.join("boards/main/src/a.circuit.tsx"), "").unwrap();

    let (project, file) = find_project(&root, "boards/main/src/a.circuit.tsx").unwrap();
    assert_eq!(project, root.join("boards/main"));
    assert_eq!(file, "src/a.circuit.tsx");
}

#[test]
fn stays_inside_the_workspace() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("package.json"), "{}").unwrap();
    std::fs::create_dir(outside.path().join("workspace")).unwrap();
    std::fs::write(outside.path().join("workspace/a.circuit.tsx"), "").unwrap();
    let root = outside.path().join("workspace");

    assert!(find_project(&root, "a.circuit.tsx").is_err());
    assert!(find_project(&root, "../package.json").is_err());
}

#[test]
fn runs_the_projects_own_tsci() {
    let project = tempfile::tempdir().unwrap();
    let package = project.path().join("node_modules/tscircuit");
    assert!(
        tscircuit_cli(project.path())
            .unwrap_err()
            .to_string()
            .contains("bun install")
    );
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(
        package.join("package.json"),
        r#"{"bin":{"tsci":"cli.mjs","tscircuit":"cli.mjs"}}"#,
    )
    .unwrap();
    assert_eq!(
        tscircuit_cli(project.path()).unwrap(),
        package.join("cli.mjs")
    );
}
