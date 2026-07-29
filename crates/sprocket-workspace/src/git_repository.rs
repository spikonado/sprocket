use std::path::Path;

use gix::bstr::{BStr, ByteSlice};

use crate::project_root::discover_repository;

/// Identity and display name for the git repository that owns a workspace directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRepositoryIdentity {
    /// Stable key used to match the same repository across directory moves/clones.
    /// Prefer a normalized `origin` remote; fall back to the workspace directory name.
    pub repository_key: String,
    /// Short label for UI grouping (repo name or directory name).
    pub display_name: String,
}

/// Resolve the repository identity for an attached workspace directory.
///
/// Discovers the enclosing git repository with `gix` (including linked worktrees),
/// stopping at the process temp root so ephemeral paths do not inherit ambient
/// git metadata. Reads `remote.origin.url` when present; otherwise falls back to
/// the workspace directory name.
pub fn resolve_git_repository_identity(workspace_root: &Path) -> GitRepositoryIdentity {
    let directory_name = directory_display_name(workspace_root);

    let Some(origin_url) = read_origin_remote_url(workspace_root) else {
        return GitRepositoryIdentity {
            repository_key: directory_name.clone(),
            display_name: directory_name,
        };
    };

    let repository_key =
        repository_key_from_url(&origin_url).unwrap_or_else(|| origin_url.to_bstring().to_string());
    let display_name =
        display_name_from_repository_key(&repository_key).unwrap_or_else(|| directory_name.clone());

    GitRepositoryIdentity {
        repository_key,
        display_name,
    }
}

fn directory_display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "workspace".to_string())
}

fn read_origin_remote_url(workspace_root: &Path) -> Option<gix::Url> {
    let repo = discover_repository(workspace_root)?;
    let remote = repo.find_remote("origin").ok()?;
    remote.url(gix::remote::Direction::Fetch).cloned()
}

/// Build a stable repository key from a parsed git remote URL.
fn repository_key_from_url(url: &gix::Url) -> Option<String> {
    let path = path_for_repository_key(url.path.as_bstr())?;

    match url.host() {
        Some(host) => {
            let host = host_for_repository_key(host);
            if path.is_empty() {
                Some(host)
            } else {
                Some(format!("{host}/{path}"))
            }
        }
        None => {
            if path.is_empty() {
                None
            } else {
                Some(path)
            }
        }
    }
}

fn host_for_repository_key(host: &str) -> String {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase()
}

fn path_for_repository_key(path: &BStr) -> Option<String> {
    let path = path.to_str().ok()?;
    Some(
        path.trim_matches('/')
            .trim_end_matches(".git")
            .to_ascii_lowercase(),
    )
}

fn display_name_from_repository_key(repository_key: &str) -> Option<String> {
    let trimmed = repository_key.trim_matches('/');
    if trimmed.is_empty() {
        return None;
    }

    trimmed
        .rsplit('/')
        .next()
        .filter(|segment| !segment.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
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
}
