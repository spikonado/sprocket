use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

fn temp_dir(label: &str) -> PathBuf {
    crate::test_support::temp_workspace_labeled(&format!("sprocket-git-repo-{label}"))
}

fn init_repo(root: &Path) -> gix::Repository {
    fs::create_dir_all(root).expect("temp dir");
    gix::init(root).expect("gix init")
}

fn init_linked_worktree(main: &Path, worktree: &Path) {
    let repo = init_repo(main);
    let signature = gix::actor::SignatureRef::from_bytes(b"sprocket <sprocket@test> 1 +0000")
        .expect("signature");
    let tree_id = repo
        .write_object(gix::objs::Tree::empty())
        .expect("write empty tree");
    let commit_id = repo
        .commit_as(
            signature,
            signature,
            "HEAD",
            "init",
            tree_id,
            None::<gix::ObjectId>,
        )
        .expect("initial commit")
        .detach();
    repo.add_worktree(
        worktree,
        gix::worktree::add::Head::Detached(commit_id),
        gix::progress::Discard,
        &AtomicBool::new(false),
    )
    .expect("add worktree");
}

fn set_origin(root: &Path, url: &str) {
    let config_path = root.join(".git/config");
    let mut config = fs::read_to_string(&config_path).expect("read config");
    config.push_str(&format!("\n[remote \"origin\"]\n\turl = {url}\n"));
    fs::write(config_path, config).expect("write config");
}

fn key_from_remote(url: &str) -> Option<String> {
    repository_key_from_url(&gix::url::parse(BStr::new(url)).expect("parse remote url"))
}

#[test]
fn normalize_https_ssh_and_scp_remotes() {
    assert_eq!(
        key_from_remote("https://github.com/spikonado/sprocket.git").as_deref(),
        Some("github.com/spikonado/sprocket")
    );
    assert_eq!(
        key_from_remote("git@github.com:spikonado/sprocket.git").as_deref(),
        Some("github.com/spikonado/sprocket")
    );
    assert_eq!(
        key_from_remote("ssh://git@github.com/spikonado/sprocket.git").as_deref(),
        Some("github.com/spikonado/sprocket")
    );
    assert_eq!(
        key_from_remote("https://GitHub.com/Spikonado/Sprocket/").as_deref(),
        Some("github.com/spikonado/sprocket")
    );
}

#[test]
fn falls_back_to_directory_name_without_git() {
    let root = temp_dir("no-git");
    fs::create_dir_all(&root).expect("temp dir");
    let identity = resolve_git_repository_identity(&root);
    assert_eq!(
        identity.repository_key,
        root.file_name().unwrap().to_string_lossy()
    );
    assert_eq!(identity.display_name, identity.repository_key);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn uses_origin_from_standard_git_directory() {
    let root = temp_dir("with-git");
    init_repo(&root);
    set_origin(&root, "https://github.com/spikonado/sprocket.git");

    let identity = resolve_git_repository_identity(&root);
    assert_eq!(identity.repository_key, "github.com/spikonado/sprocket");
    assert_eq!(identity.display_name, "sprocket");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn uses_origin_from_nested_workdir_path() {
    let root = temp_dir("nested");
    init_repo(&root);
    set_origin(&root, "https://github.com/spikonado/sprocket.git");
    let nested = root.join("crates").join("demo");
    fs::create_dir_all(&nested).expect("nested dir");

    let identity = resolve_git_repository_identity(&nested);
    assert_eq!(identity.repository_key, "github.com/spikonado/sprocket");
    assert_eq!(identity.display_name, "sprocket");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn uses_origin_from_worktree_gitdir_pointer() {
    let root = temp_dir("worktree");
    let main = root.join("main");
    let worktree = root.join("feature");
    init_linked_worktree(&main, &worktree);
    let config_without_origin = fs::read_to_string(main.join(".git/config")).expect("read config");
    set_origin(&main, "git@github.com:spikonado/sprocket.git");

    let identity = resolve_git_repository_identity(&worktree);
    assert_eq!(identity.repository_key, "github.com/spikonado/sprocket");
    assert_eq!(identity.display_name, "sprocket");

    fs::write(main.join(".git/config"), config_without_origin).expect("remove origin");
    let main_identity = resolve_git_repository_identity(&main);
    let worktree_identity = resolve_git_repository_identity(&worktree);
    assert_eq!(main_identity.repository_key, "main");
    assert_eq!(
        worktree_identity.repository_key,
        main_identity.repository_key
    );
    assert_eq!(
        worktree_identity.attachment_key,
        main_identity.attachment_key
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn uses_directory_name_when_git_has_no_origin() {
    let root = temp_dir("no-origin");
    init_repo(&root);

    let identity = resolve_git_repository_identity(&root);
    assert_eq!(
        identity.repository_key,
        root.file_name().unwrap().to_string_lossy()
    );
    assert_eq!(identity.display_name, identity.repository_key);
    let _ = fs::remove_dir_all(root);
}
