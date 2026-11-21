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

#[tokio::test]
async fn pulls_new_upstream_commits_and_keeps_diverged_work() {
    let root = temp_workspace_labeled("sprocket-git-pull-tests");
    let upstream = root.join("upstream.git");
    let checkout = root.join("checkout");
    let other = root.join("other");
    git(
        &root,
        &["init", "--bare", "--initial-branch=main", "upstream.git"],
    );
    git(&root, &["clone", "upstream.git", "other"]);
    git(&other, &["commit", "--allow-empty", "-m", "first"]);
    git(&other, &["push", "origin", "main"]);
    git(&root, &["clone", upstream.to_str().unwrap(), "checkout"]);

    git(&other, &["commit", "--allow-empty", "-m", "second"]);
    git(&other, &["push", "origin", "main"]);
    pull_fast_forward(&checkout, Vec::new()).await.unwrap();
    assert_eq!(
        git(&checkout, &["rev-parse", "HEAD"]),
        git(&other, &["rev-parse", "HEAD"])
    );

    git(&other, &["commit", "--allow-empty", "-m", "upstream"]);
    git(&other, &["push", "origin", "main"]);
    git(&checkout, &["commit", "--allow-empty", "-m", "local"]);
    let local = git(&checkout, &["rev-parse", "HEAD"]);
    assert!(pull_fast_forward(&checkout, Vec::new()).await.is_err());
    assert_eq!(git(&checkout, &["rev-parse", "HEAD"]), local);

    std::fs::remove_dir_all(root).unwrap();
}
