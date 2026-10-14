use super::*;
use std::fs;
use std::path::PathBuf;

fn temp_dir(label: &str) -> PathBuf {
    crate::test_support::temp_workspace_labeled(&format!("sprocket-git-repo-{label}"))
}

fn init_repo(root: &Path) {
    fs::create_dir_all(root).expect("temp dir");
    gix::init(root).expect("gix init");
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
    init_repo(&main);
    let config_without_origin = fs::read_to_string(main.join(".git/config")).expect("read config");
    set_origin(&main, "git@github.com:spikonado/sprocket.git");

    // Fabricate a linked-worktree layout (gix has no worktree-add API).
    let main_git = main.join(".git");
    let worktree_gitdir = main_git.join("worktrees").join("feature");
    fs::create_dir_all(&worktree_gitdir).expect("worktree gitdir");
    fs::create_dir_all(&worktree).expect("worktree dir");

    let main_abs = fs::canonicalize(&main).expect("canonicalize main");
    let worktree_abs = fs::canonicalize(&worktree).expect("canonicalize worktree");
    fs::write(
        worktree.join(".git"),
        format!(
            "gitdir: {}\n",
            main_abs.join(".git/worktrees/feature").display()
        ),
    )
    .expect("write worktree .git pointer");
    fs::write(worktree_gitdir.join("commondir"), "../..\n").expect("write commondir");
    fs::write(
        worktree_gitdir.join("gitdir"),
        format!("{}\n", worktree_abs.join(".git").display()),
    )
    .expect("write gitdir");
    // gix discover requires a valid HEAD in the worktree-private gitdir.
    fs::write(worktree_gitdir.join("HEAD"), "ref: refs/heads/feature\n").expect("write HEAD");

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
