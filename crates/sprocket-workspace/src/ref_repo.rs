use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::tools::{WorkspaceCancellation, WorkspaceOperationCancelled};

const CLONE_DEPTH: &str = "1";
const CLONE_TIMEOUT: Duration = Duration::from_secs(300);
const LOCAL_GIT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_GIT_ERROR_BYTES: usize = 16_384;
const CACHE_METADATA_FILE: &str = ".git/sprocket-ref-repo.json";
static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneRefRepoOutput {
    pub path: String,
    pub commit: String,
    pub reused: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct CacheMetadata {
    url: String,
    reference: Option<String>,
    commit: String,
}

/// Clone a remote into Sprocket's repository cache, or reuse an identical clone.
///
/// A temporary sibling is populated first and atomically renamed, so interrupted
/// clones never look complete. The destination includes the requested reference
/// and a URL hash; the origin is still checked before any existing clone is reused.
pub async fn clone_ref_repo(
    ref_repos_root: PathBuf,
    cancellation: WorkspaceCancellation,
    url: &str,
    reference: Option<&str>,
) -> Result<CloneRefRepoOutput> {
    cancellation.ensure_active()?;
    let url = validate_value("repository URL", url)?;
    reject_embedded_credentials(url)?;
    validate_remote_url(url)?;
    clone_ref_repo_validated(ref_repos_root, cancellation, url, reference, false).await
}

async fn clone_ref_repo_validated(
    ref_repos_root: PathBuf,
    cancellation: WorkspaceCancellation,
    url: &str,
    reference: Option<&str>,
    allow_local_fixture: bool,
) -> Result<CloneRefRepoOutput> {
    let reference = reference
        .map(|value| validate_value("reference", value))
        .transpose()?;

    tokio::fs::create_dir_all(&ref_repos_root)
        .await
        .with_context(|| {
            format!(
                "failed to create repository cache {}",
                ref_repos_root.display()
            )
        })?;
    let ref_repos_root = tokio::fs::canonicalize(&ref_repos_root)
        .await
        .with_context(|| {
            format!(
                "failed to resolve repository cache {}",
                ref_repos_root.display()
            )
        })?;

    let base_name = ref_repo_directory_name(url, reference);
    if let Some(output) =
        find_existing_clone(&ref_repos_root, &base_name, url, reference, &cancellation).await?
    {
        return Ok(output);
    }

    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp_path = ref_repos_root.join(format!(
        ".clone-{}-{started_at}-{}",
        std::process::id(),
        NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let clone_result = run_clone(
        &temp_path,
        &cancellation,
        url,
        reference,
        allow_local_fixture,
    )
    .await;
    if let Err(error) = clone_result {
        let _ = tokio::fs::remove_dir_all(&temp_path).await;
        return Err(error);
    }
    let commit = match validate_new_clone(&temp_path, url, &cancellation).await {
        Ok(commit) => commit,
        Err(error) => {
            let _ = tokio::fs::remove_dir_all(&temp_path).await;
            return Err(error);
        }
    };
    let metadata = CacheMetadata {
        url: url.to_owned(),
        reference: reference.map(str::to_owned),
        commit: commit.clone(),
    };
    if let Err(error) = write_cache_metadata(&temp_path, &metadata).await {
        let _ = tokio::fs::remove_dir_all(&temp_path).await;
        return Err(error);
    }

    // Another process may have completed the same clone while ours was running.
    // Try progressively suffixed names as well, which also makes hash collisions safe.
    for suffix in 1_u32.. {
        if let Err(error) = cancellation.ensure_active() {
            let _ = tokio::fs::remove_dir_all(&temp_path).await;
            return Err(error);
        }
        let destination = candidate_path(&ref_repos_root, &base_name, suffix);
        let destination_exists = match path_entry_exists(&destination).await {
            Ok(exists) => exists,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&temp_path).await;
                return Err(error);
            }
        };
        if destination_exists {
            match validate_cached_clone(&destination, url, reference, &cancellation).await {
                Ok(Some(output)) => {
                    let _ = tokio::fs::remove_dir_all(&temp_path).await;
                    return Ok(output);
                }
                Ok(None) => continue,
                Err(error) => {
                    let _ = tokio::fs::remove_dir_all(&temp_path).await;
                    return Err(error);
                }
            }
        }

        match tokio::fs::rename(&temp_path, &destination).await {
            Ok(()) => {
                return Ok(CloneRefRepoOutput {
                    path: destination.to_string_lossy().into_owned(),
                    commit,
                    reused: false,
                });
            }
            Err(rename_error) => {
                let destination_exists = match path_entry_exists(&destination).await {
                    Ok(exists) => exists,
                    Err(error) => {
                        let _ = tokio::fs::remove_dir_all(&temp_path).await;
                        return Err(error);
                    }
                };
                if destination_exists {
                    match validate_cached_clone(&destination, url, reference, &cancellation).await {
                        Ok(Some(output)) => {
                            let _ = tokio::fs::remove_dir_all(&temp_path).await;
                            return Ok(output);
                        }
                        Ok(None) => continue,
                        Err(error) => {
                            let _ = tokio::fs::remove_dir_all(&temp_path).await;
                            return Err(error);
                        }
                    }
                }
                let _ = tokio::fs::remove_dir_all(&temp_path).await;
                return Err(rename_error).with_context(|| {
                    format!(
                        "failed to install cloned repository at {}",
                        destination.display()
                    )
                });
            }
        }
    }

    unreachable!("repository suffix space is not exhaustible")
}

fn validate_remote_url(url: &str) -> Result<()> {
    let valid = if let Some(remainder) = url.strip_prefix("https://") {
        remainder
            .split('/')
            .next()
            .and_then(|authority| authority.split(':').next())
            .is_some_and(valid_git_host)
    } else if let Some(remainder) = url.strip_prefix("ssh://") {
        let authority = remainder.split('/').next().unwrap_or_default();
        authority
            .strip_prefix("git@")
            .unwrap_or(authority)
            .split(':')
            .next()
            .is_some_and(valid_git_host)
    } else if let Some(remainder) = url.strip_prefix("git@") {
        remainder
            .split_once(':')
            .is_some_and(|(host, path)| valid_git_host(host) && !path.is_empty())
    } else {
        false
    };
    if !valid {
        bail!("repository URL must be an HTTPS or SSH Git remote");
    }
    Ok(())
}

fn valid_git_host(host: &str) -> bool {
    !host.is_empty()
        && !host.starts_with('-')
        && host
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-'))
}

fn validate_value<'a>(name: &str, value: &'a str) -> Result<&'a str> {
    let value = value.trim();
    if value.is_empty() {
        bail!("{name} cannot be empty");
    }
    if value.chars().any(char::is_control) {
        bail!("{name} cannot contain control characters");
    }
    Ok(value)
}

fn reject_embedded_credentials(url: &str) -> Result<()> {
    if url.contains(['?', '#']) {
        bail!("repository URLs cannot contain query parameters or fragments");
    }
    if let Some((scheme, remainder)) = url.split_once("://") {
        let authority = remainder.split('/').next().unwrap_or(remainder);
        let allowed_ssh_user = scheme.eq_ignore_ascii_case("ssh")
            && authority
                .split_once('@')
                .is_some_and(|(user, _)| user == "git");
        if authority.contains('@') && !allowed_ssh_user {
            bail!(
                "repository URLs cannot contain credentials; use Git's credential helper or SSH authentication"
            );
        }
    } else if url.contains('@') && !url.starts_with("git@") {
        bail!(
            "repository URLs cannot contain credentials; use Git's credential helper or SSH authentication"
        );
    }
    Ok(())
}

fn ref_repo_directory_name(url: &str, reference: Option<&str>) -> String {
    let without_query = url.split(['?', '#']).next().unwrap_or(url);
    let name = without_query
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', ':'])
        .next()
        .unwrap_or("repository");
    let name = name.strip_suffix(".git").unwrap_or(name);
    let slug: String = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .take(64)
        .collect();
    let slug = slug.trim_matches(['-', '.']);
    let slug = if slug.is_empty() { "repository" } else { slug };

    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    hasher.update([0]);
    if let Some(reference) = reference {
        hasher.update(reference.as_bytes());
    }
    let digest = hasher.finalize();
    format!("{slug}-{}", hex_prefix(&digest[..8]))
}

fn hex_prefix(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn candidate_path(root: &Path, base_name: &str, suffix: u32) -> PathBuf {
    if suffix == 1 {
        root.join(base_name)
    } else {
        root.join(format!("{base_name}-{suffix}"))
    }
}

async fn find_existing_clone(
    root: &Path,
    base_name: &str,
    url: &str,
    reference: Option<&str>,
    cancellation: &WorkspaceCancellation,
) -> Result<Option<CloneRefRepoOutput>> {
    for suffix in 1_u32.. {
        cancellation.ensure_active()?;
        let candidate = candidate_path(root, base_name, suffix);
        if !path_entry_exists(&candidate).await? {
            return Ok(None);
        }
        if let Some(output) =
            validate_cached_clone(&candidate, url, reference, cancellation).await?
        {
            return Ok(Some(output));
        }
    }
    unreachable!("repository suffix space is not exhaustible")
}

async fn path_entry_exists(path: &Path) -> Result<bool> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("failed to inspect {}", path.display())),
    }
}

async fn validate_new_clone(
    path: &Path,
    url: &str,
    cancellation: &WorkspaceCancellation,
) -> Result<String> {
    if !ref_repo_origin_matches(path, url, cancellation).await? {
        bail!("cloned repository origin does not match the requested URL");
    }
    read_head(path, cancellation).await
}

async fn write_cache_metadata(path: &Path, metadata: &CacheMetadata) -> Result<()> {
    let contents =
        serde_json::to_vec(metadata).context("failed to serialize repository cache metadata")?;
    tokio::fs::write(path.join(CACHE_METADATA_FILE), contents)
        .await
        .context("failed to write repository cache metadata")
}

async fn validate_cached_clone(
    path: &Path,
    url: &str,
    reference: Option<&str>,
    cancellation: &WorkspaceCancellation,
) -> Result<Option<CloneRefRepoOutput>> {
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("failed to inspect repository cache entry"),
    };
    if !metadata.file_type().is_dir() {
        return Ok(None);
    }
    let contents = match tokio::fs::read(path.join(CACHE_METADATA_FILE)).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("failed to read repository cache metadata"),
    };
    let metadata: CacheMetadata = match serde_json::from_slice(&contents) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(None),
    };
    if metadata.url != url || metadata.reference.as_deref() != reference {
        return Ok(None);
    }
    if !ref_repo_origin_matches(path, url, cancellation).await? {
        return Ok(None);
    }
    let head = match read_head(path, cancellation).await {
        Ok(head) => head,
        Err(_) => {
            cancellation.ensure_active()?;
            return Ok(None);
        }
    };
    if head != metadata.commit {
        return Ok(None);
    }
    if !ref_repo_worktree_clean(path, cancellation).await? {
        return Ok(None);
    }
    Ok(Some(CloneRefRepoOutput {
        path: path.to_string_lossy().into_owned(),
        commit: metadata.commit,
        reused: true,
    }))
}

async fn ref_repo_worktree_clean(
    path: &Path,
    cancellation: &WorkspaceCancellation,
) -> Result<bool> {
    let mut command = Command::new("git");
    command
        .args(["-C"])
        .arg(path)
        .args(["status", "--porcelain=v1", "--untracked-files=all"]);
    let output = run_local_git(command, cancellation).await?;
    Ok(output.status.success() && output.stdout.is_empty())
}

async fn ref_repo_origin_matches(
    path: &Path,
    url: &str,
    cancellation: &WorkspaceCancellation,
) -> Result<bool> {
    if !path.is_dir() {
        return Ok(false);
    }
    let mut command = Command::new("git");
    command
        .args(["-C"])
        .arg(path)
        .args(["remote", "get-url", "origin"]);
    let output = run_local_git(command, cancellation).await?;
    Ok(output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == url)
}

async fn run_clone(
    destination: &Path,
    cancellation: &WorkspaceCancellation,
    url: &str,
    reference: Option<&str>,
    allow_local_fixture: bool,
) -> Result<()> {
    let mut command = Command::new("git");
    command.args(["clone", "--depth", CLONE_DEPTH]);
    if let Some(reference) = reference {
        command.args(["--branch", reference, "--single-branch"]);
    }
    command
        .arg("--")
        .arg(url)
        .arg(destination)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .env(
            "GIT_ALLOW_PROTOCOL",
            if allow_local_fixture {
                "file:https:ssh"
            } else {
                "https:ssh"
            },
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command
        .spawn()
        .context("failed to run git; install Git to clone repositories")?;
    let process_id = child.id();
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("failed to capture git clone error output"))?;
    let stderr_task = tokio::spawn(async move {
        let mut captured = Vec::new();
        let mut buffer = [0_u8; 8_192];
        loop {
            let count = stderr.read(&mut buffer).await?;
            if count == 0 {
                return Ok::<_, std::io::Error>(captured);
            }
            let remaining = MAX_GIT_ERROR_BYTES.saturating_sub(captured.len());
            captured.extend_from_slice(&buffer[..count.min(remaining)]);
        }
    });

    let status = tokio::select! {
        biased;
        _ = cancellation.cancelled() => {
            terminate_clone(&mut child, process_id).await;
            let _ = child.wait().await;
            let _ = stderr_task.await;
            return Err(WorkspaceOperationCancelled.into());
        }
        _ = tokio::time::sleep(CLONE_TIMEOUT) => {
            terminate_clone(&mut child, process_id).await;
            let _ = child.wait().await;
            let _ = stderr_task.await;
            bail!("git clone timed out after {} seconds", CLONE_TIMEOUT.as_secs());
        }
        status = child.wait() => status.context("failed while waiting for git clone")?,
    };
    let stderr = stderr_task
        .await
        .context("git clone error reader stopped unexpectedly")??;
    if status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&stderr)
        .replace(url, "<repository URL>")
        .trim()
        .to_string();
    if detail.is_empty() {
        bail!("git clone failed with {status}");
    }
    bail!("git clone failed: {detail}")
}

async fn terminate_clone(child: &mut tokio::process::Child, process_id: Option<u32>) {
    #[cfg(unix)]
    if let Some(process_id) = process_id {
        // SAFETY: the child was placed in a new process group whose ID is its PID.
        unsafe {
            libc::kill(-(process_id as i32), libc::SIGKILL);
        }
        return;
    }
    let _ = child.kill().await;
}

async fn run_local_git(
    mut command: Command,
    cancellation: &WorkspaceCancellation,
) -> Result<std::process::Output> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(WorkspaceOperationCancelled.into()),
        result = tokio::time::timeout(LOCAL_GIT_TIMEOUT, command.output()) => {
            result.context("local git command timed out")?
                .context("failed to run git; install Git to clone repositories")
        }
    }
}

async fn read_head(path: &Path, cancellation: &WorkspaceCancellation) -> Result<String> {
    let mut command = Command::new("git");
    command.args(["-C"]).arg(&path).args(["rev-parse", "HEAD"]);
    let output = run_local_git(command, cancellation).await?;
    if !output.status.success() {
        bail!(
            "cached repository at {} is not a valid checkout",
            path.display()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command as StdCommand;

    use super::{clone_ref_repo, clone_ref_repo_validated, ref_repo_directory_name};
    use crate::WorkspaceCancellation;
    use crate::test_support::temp_workspace;

    fn run_git(directory: &Path, args: &[&str]) {
        let status = StdCommand::new("git")
            .args(["-C"])
            .arg(directory)
            .args(args)
            .status()
            .expect("git should start");
        assert!(status.success(), "git {args:?} failed");
    }

    fn create_repository(root: &Path) -> PathBuf {
        let source = root.join("source.git");
        fs::create_dir(&source).expect("source directory");
        run_git(&source, &["init", "--initial-branch=main"]);
        run_git(&source, &["config", "user.name", "Sprocket Test"]);
        run_git(&source, &["config", "user.email", "test@sprocket.local"]);
        fs::write(source.join("README.md"), "hello\n").expect("fixture file");
        run_git(&source, &["add", "README.md"]);
        run_git(&source, &["commit", "-m", "initial"]);
        source
    }

    #[tokio::test]
    async fn reuses_matching_clone_without_overwriting_a_collision() {
        let root = temp_workspace();
        let source = create_repository(&root);
        let cache = root.join("cache");
        fs::create_dir(&cache).expect("cache directory");
        let url = source.to_string_lossy().into_owned();
        let collision = cache.join(ref_repo_directory_name(&url, None));
        fs::create_dir(&collision).expect("collision fixture");

        let first = clone_ref_repo_validated(
            cache.clone(),
            WorkspaceCancellation::new(),
            &url,
            None,
            true,
        )
        .await
        .expect("repository should clone");
        let second = clone_ref_repo_validated(
            cache.clone(),
            WorkspaceCancellation::new(),
            &url,
            None,
            true,
        )
        .await
        .expect("repository should be reused");

        assert!(!first.reused);
        assert!(second.reused);
        assert_eq!(first.path, second.path);
        assert_eq!(first.commit, second.commit);
        assert!(collision.is_dir());
        assert!(fs::read_dir(collision).unwrap().next().is_none());

        fs::write(Path::new(&first.path).join("README.md"), "tampered\n")
            .expect("tampered fixture");

        let replacement =
            clone_ref_repo_validated(cache, WorkspaceCancellation::new(), &url, None, true)
                .await
                .expect("tampered repository should be replaced");
        assert!(!replacement.reused);
        assert_ne!(replacement.path, first.path);
        assert_eq!(replacement.commit, first.commit);
        fs::remove_dir_all(root).expect("temp directory should be removed");
    }

    #[tokio::test]
    async fn rejects_local_path_before_creating_the_cache() {
        let root = temp_workspace();
        let source = create_repository(&root);
        let cache = root.join("cache");
        let error = clone_ref_repo(
            cache.clone(),
            WorkspaceCancellation::new(),
            &source.to_string_lossy(),
            None,
        )
        .await
        .expect_err("local repository paths should be rejected");

        assert!(error.to_string().contains("HTTPS or SSH"));
        assert!(!cache.exists());
        fs::remove_dir_all(root).expect("temp directory should be removed");
    }

    #[tokio::test]
    async fn rejects_credentials_before_creating_the_cache() {
        let root = temp_workspace();
        let cache = root.join("cache");
        let error = clone_ref_repo(
            cache.clone(),
            WorkspaceCancellation::new(),
            "https://token@example.com/org/repo.git",
            None,
        )
        .await
        .expect_err("embedded credentials should be rejected");

        assert!(error.to_string().contains("cannot contain credentials"));
        assert!(!cache.exists());
        fs::remove_dir_all(root).expect("temp directory should be removed");
    }
}
