use super::rebase_onto_cwd;

#[test]
fn paths_rebase_onto_the_cwd_and_stay_workspace_relative_inside_it() {
    let base = std::env::temp_dir();
    let root = base.join("repo");
    let worktree = root.join(".worktrees").join("x");
    let elsewhere = base.join("elsewhere");
    let absolute = base.join("abs.md").to_string_lossy().into_owned();

    assert_eq!(rebase_onto_cwd(&root, &root, "./notes.md"), "./notes.md");
    assert_eq!(
        rebase_onto_cwd(&root, &worktree, "a.md"),
        std::path::Path::new(".worktrees")
            .join("x")
            .join("a.md")
            .to_string_lossy()
    );
    assert_eq!(
        rebase_onto_cwd(&root, &elsewhere, "a.md"),
        elsewhere.join("a.md").to_string_lossy()
    );
    assert_eq!(rebase_onto_cwd(&root, &worktree, &absolute), absolute);
}
