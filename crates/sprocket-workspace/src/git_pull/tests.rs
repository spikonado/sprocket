use std::path::Path;
use std::process::Command;

use super::pull_fast_forward;
use crate::test_support::temp_workspace_labeled;

fn git(directory: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
        .args(args)
        .current_dir(directory)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

fn push_notes(directory: &Path, contents: &str) {
    std::fs::write(directory.join("notes"), contents).unwrap();
    git(directory, &["add", "notes"]);
    git(directory, &["commit", "-m", contents]);
    git(directory, &["push", "origin", "main"]);
}

#[tokio::test]
async fn pulls_new_upstream_commits_and_keeps_local_work() {
    let root = temp_workspace_labeled("sprocket-git-pull-tests");
    let upstream = root.join("upstream.git");
    let checkout = root.join("checkout");
    let other = root.join("other");
    git(
        &root,
        &["init", "--bare", "--initial-branch=main", "upstream.git"],
    );
    git(&root, &["clone", "upstream.git", "other"]);
    push_notes(&other, "first");
    git(&root, &["clone", upstream.to_str().unwrap(), "checkout"]);

    push_notes(&other, "second");
    pull_fast_forward(&checkout, Vec::new()).await.unwrap();
    assert_eq!(
        git(&checkout, &["rev-parse", "HEAD"]),
        git(&other, &["rev-parse", "HEAD"])
    );

    push_notes(&other, "upstream");
    git(&checkout, &["config", "merge.autostash", "true"]);
    std::fs::write(checkout.join("notes"), "uncommitted").unwrap();
    let before = git(&checkout, &["rev-parse", "HEAD"]);
    assert!(pull_fast_forward(&checkout, Vec::new()).await.is_err());
    assert_eq!(git(&checkout, &["rev-parse", "HEAD"]), before);
    assert_eq!(
        std::fs::read_to_string(checkout.join("notes")).unwrap(),
        "uncommitted"
    );

    git(&checkout, &["checkout", "--", "notes"]);
    git(&checkout, &["commit", "--allow-empty", "-m", "local"]);
    let local = git(&checkout, &["rev-parse", "HEAD"]);
    assert!(pull_fast_forward(&checkout, Vec::new()).await.is_err());
    assert_eq!(git(&checkout, &["rev-parse", "HEAD"]), local);

    std::fs::remove_dir_all(root).unwrap();
}
