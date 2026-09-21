use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sprocket_workspace::{
    resolve_git_repository_identity, resolve_or_create_workspace_root, resolve_workspace_root,
};
use tokio::sync::{Mutex, RwLock};

const PROJECT_ATTACHMENTS_FILE: &str = "project-attachments.json";
const STALE_UNAVAILABLE_WORKSPACE_MS: u64 = 1000 * 60 * 60 * 24 * 30;
const MAX_PERSISTED_PROJECT_ATTACHMENTS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAttachmentRecord {
    pub workspace_path: String,
    pub repository_key: String,
    pub attachment_key: String,
    pub display_name: String,
    pub availability: WorkspaceAvailability,
    pub last_validated_at: u64,
    pub last_used_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    /// First pending key retained for older clients.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_repository_key: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub previous_repository_keys: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceAvailability {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachProjectRequest {
    pub workspace_path: String,
    #[serde(default)]
    pub replace_workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathResolution {
    pub workspace_path: String,
    /// Short UI label for the repository (repo name or directory name).
    pub display_name: String,
    /// Stable repository identity from git origin, or the directory name when unset.
    pub repository_key: String,
    pub attachment_key: String,
}

pub struct ProjectAttachmentStore {
    data_dir: PathBuf,
    attachments: RwLock<HashMap<String, ProjectAttachmentRecord>>,
    loaded: RwLock<bool>,
    update_lock: Mutex<()>,
}

impl ProjectAttachmentStore {
    pub fn new(data_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            data_dir,
            attachments: RwLock::new(HashMap::new()),
            loaded: RwLock::new(false),
            update_lock: Mutex::new(()),
        })
    }

    pub async fn list(&self) -> Result<Vec<ProjectAttachmentRecord>> {
        self.ensure_loaded().await?;
        self.refresh_all().await?;
        let sessions = self.attachments.read().await;
        let mut listed: Vec<ProjectAttachmentRecord> = sessions.values().cloned().collect();
        listed.sort_by_key(|session| std::cmp::Reverse(session.last_used_at));
        Ok(listed)
    }

    pub async fn attach(&self, request: AttachProjectRequest) -> Result<ProjectAttachmentRecord> {
        self.ensure_loaded().await?;
        let validated = resolve_attachment(request.workspace_path).await?;
        let replace_workspace_path = request
            .replace_workspace_path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty() && *path != validated.workspace_path)
            .map(str::to_owned);

        let _update_guard = self.update_lock.lock().await;
        {
            let mut sessions = self.attachments.write().await;
            if let Some(previous_path) = replace_workspace_path.as_deref()
                && !sessions.contains_key(previous_path)
            {
                anyhow::bail!("Replacement workspace is not attached");
            }
            if let Some(existing) = sessions.values().find(|attachment| {
                same_attachment_identity(attachment, &validated)
                    && match replace_workspace_path.as_deref() {
                        Some(previous_path) => attachment.workspace_path != previous_path,
                        None => attachment.workspace_path != validated.workspace_path,
                    }
            }) {
                anyhow::bail!(
                    "Repository is already attached to {}",
                    existing.workspace_path
                );
            }
            sessions.insert(validated.workspace_path.clone(), validated.clone());
            if let Some(previous_path) = replace_workspace_path.as_deref() {
                sessions.remove(previous_path);
            }
            deduplicate_repository_attachments(
                &mut sessions,
                Some(validated.workspace_path.as_str()),
            );
        }
        self.save_to_disk().await?;
        Ok(validated)
    }

    pub async fn resolve_run_workspace(
        &self,
        workspace_path: String,
    ) -> Result<ProjectAttachmentRecord> {
        self.ensure_loaded().await?;
        let mut resolved = resolve_attachment(workspace_path).await?;
        let _update_guard = self.update_lock.lock().await;
        let changed = {
            let mut attachments = self.attachments.write().await;
            let mut changed = deduplicate_repository_attachments(&mut attachments, None);
            let existing = attachments
                .values()
                .find(|attachment| same_attachment_identity(attachment, &resolved))
                .cloned();

            match existing {
                Some(existing) => {
                    resolved.previous_repository_key = existing.previous_repository_key;
                    resolved.previous_repository_keys = existing.previous_repository_keys;
                    if existing.workspace_path == resolved.workspace_path {
                        attachments.insert(resolved.workspace_path.clone(), resolved.clone());
                        changed = true;
                    }
                }
                None => {
                    attachments.insert(resolved.workspace_path.clone(), resolved.clone());
                    changed = true;
                }
            }
            changed
        };
        if changed {
            self.save_to_disk().await?;
        }
        Ok(resolved)
    }

    pub async fn workspace_path(&self, workspace_path: &str) -> Result<String> {
        Ok(self
            .require_available_workspace(workspace_path)
            .await?
            .workspace_path)
    }

    pub async fn require_available_workspace(
        &self,
        workspace_path: &str,
    ) -> Result<ProjectAttachmentRecord> {
        self.ensure_loaded().await?;
        let session = self.get_or_error(workspace_path).await?;
        let validated = validate_session_async(session).await?;
        if validated.availability != WorkspaceAvailability::Available {
            anyhow::bail!(
                validated
                    .unavailable_reason
                    .unwrap_or_else(|| "workspace path is unavailable".to_string())
            );
        }
        Ok(validated)
    }

    pub async fn require_matching_workspace(
        &self,
        workspace_path: &str,
        repository_key: &str,
    ) -> Result<ProjectAttachmentRecord> {
        let attachment = self.require_available_workspace(workspace_path).await?;
        if !repository_key_matches(&attachment, repository_key) {
            anyhow::bail!("repositoryKey does not match the attached workspace");
        }
        Ok(attachment)
    }

    async fn get_or_error(&self, workspace_path: &str) -> Result<ProjectAttachmentRecord> {
        let attachments = self.attachments.read().await;
        attachments.get(workspace_path).cloned().ok_or_else(|| {
            anyhow::anyhow!("Project path is unavailable. Re-open this project in the desktop app.")
        })
    }

    async fn ensure_loaded(&self) -> Result<()> {
        let mut loaded = self.loaded.write().await;
        if *loaded {
            return Ok(());
        }

        tokio::fs::create_dir_all(&self.data_dir).await?;
        let store_path = self.data_dir.join(PROJECT_ATTACHMENTS_FILE);
        if tokio::fs::try_exists(&store_path).await? {
            let contents = tokio::fs::read_to_string(&store_path)
                .await
                .with_context(|| format!("failed to read {}", store_path.display()))?;
            let stored: Vec<ProjectAttachmentRecord> = serde_json::from_str(&contents)
                .with_context(|| "failed to parse project attachments")?;
            let mut sessions = self.attachments.write().await;
            for attachment in stored {
                if attachment.workspace_path.trim().is_empty() {
                    continue;
                }
                let record = validate_session_path(attachment);
                sessions.insert(record.workspace_path.clone(), record);
            }
        }

        *loaded = true;
        Ok(())
    }

    async fn refresh_all(&self) -> Result<()> {
        let _update_guard = self.update_lock.lock().await;
        let snapshot: Vec<(String, ProjectAttachmentRecord)> = self
            .attachments
            .read()
            .await
            .iter()
            .map(|(workspace_path, attachment)| (workspace_path.clone(), attachment.clone()))
            .collect();
        let validated = tokio::task::spawn_blocking(move || {
            snapshot
                .into_iter()
                .map(|(previous_key, original)| {
                    let refreshed = validate_session_path(original.clone());
                    (previous_key, original, refreshed)
                })
                .collect::<Vec<_>>()
        })
        .await
        .context("project attachment validation task failed")?;

        let mut changed = false;
        let mut sessions = self.attachments.write().await;
        for (previous_key, original, refreshed) in validated {
            if sessions.get(&previous_key) != Some(&original) {
                continue;
            }

            if session_record_changed(&original, &refreshed) {
                changed = true;
            }
            if previous_key != refreshed.workspace_path {
                sessions.remove(&previous_key);
            }
            sessions.insert(refreshed.workspace_path.clone(), refreshed);
        }
        if deduplicate_repository_attachments(&mut sessions, None) {
            changed = true;
        }
        drop(sessions);

        if changed {
            self.save_to_disk().await?;
        }

        Ok(())
    }

    async fn save_to_disk(&self) -> Result<()> {
        self.prune().await;
        let store_path = self.data_dir.join(PROJECT_ATTACHMENTS_FILE);
        let payload = {
            let sessions = self.attachments.read().await;
            serde_json::to_vec_pretty(&sessions.values().collect::<Vec<_>>())?
        };
        tokio::task::spawn_blocking(move || {
            crate::profile::write_private_file(&store_path, &payload)
        })
        .await??;
        Ok(())
    }

    async fn prune(&self) {
        let now = crate::now_ms();
        let mut store = self.attachments.write().await;
        let mut sessions: Vec<ProjectAttachmentRecord> = store
            .values()
            .filter(|session| {
                session.availability == WorkspaceAvailability::Available
                    || now.saturating_sub(session.last_validated_at)
                        < STALE_UNAVAILABLE_WORKSPACE_MS
            })
            .cloned()
            .collect();

        sessions.sort_by_key(|session| std::cmp::Reverse(session.last_used_at));
        sessions.truncate(MAX_PERSISTED_PROJECT_ATTACHMENTS);

        store.clear();
        for session in sessions {
            store.insert(session.workspace_path.clone(), session);
        }
    }
}

fn deduplicate_repository_attachments(
    attachments: &mut HashMap<String, ProjectAttachmentRecord>,
    preferred_workspace_path: Option<&str>,
) -> bool {
    let mut winners = HashMap::<String, String>::new();
    let mut changed = false;

    for (workspace_path, attachment) in attachments.iter() {
        let Some(current_path) = winners.get(&attachment.attachment_key) else {
            winners.insert(attachment.attachment_key.clone(), workspace_path.clone());
            continue;
        };
        let current = &attachments[current_path];

        if attachment_is_preferred(attachment, current, preferred_workspace_path) {
            winners.insert(attachment.attachment_key.clone(), workspace_path.clone());
        }
    }

    let mut pending_rekeys = HashMap::<String, BTreeSet<String>>::new();
    for attachment in attachments.values() {
        pending_rekeys
            .entry(attachment.attachment_key.clone())
            .or_default()
            .extend(pending_repository_keys(attachment));
    }
    for (attachment_key, previous_repository_keys) in pending_rekeys {
        let Some(winner_path) = winners.get(&attachment_key) else {
            continue;
        };
        let Some(winner) = attachments.get_mut(winner_path) else {
            continue;
        };
        changed |= set_pending_repository_keys(winner, previous_repository_keys);
    }

    let previous_len = attachments.len();
    attachments.retain(|workspace_path, attachment| {
        winners.get(&attachment.attachment_key) == Some(workspace_path)
    });
    changed || attachments.len() != previous_len
}

fn same_attachment_identity(
    left: &ProjectAttachmentRecord,
    right: &ProjectAttachmentRecord,
) -> bool {
    left.attachment_key == right.attachment_key
}

fn attachment_is_preferred(
    candidate: &ProjectAttachmentRecord,
    current: &ProjectAttachmentRecord,
    preferred_workspace_path: Option<&str>,
) -> bool {
    match preferred_workspace_path {
        Some(path) if candidate.workspace_path == path => return true,
        Some(path) if current.workspace_path == path => return false,
        _ => {}
    }

    if candidate.availability != current.availability {
        return candidate.availability == WorkspaceAvailability::Available;
    }
    match candidate.last_used_at.cmp(&current.last_used_at) {
        Ordering::Equal => {
            candidate
                .workspace_path
                .encode_utf16()
                .cmp(current.workspace_path.encode_utf16())
                == Ordering::Less
        }
        ordering => ordering == Ordering::Less,
    }
}

fn directory_name(workspace_path: &str) -> String {
    std::path::Path::new(workspace_path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("workspace")
        .to_string()
}

fn mark_available(
    session: ProjectAttachmentRecord,
    resolution: WorkspacePathResolution,
) -> ProjectAttachmentRecord {
    let previous_repository_keys =
        previous_repository_keys_after_resolve(&session, &resolution.repository_key);
    ProjectAttachmentRecord {
        workspace_path: resolution.workspace_path,
        attachment_key: resolution.attachment_key,
        previous_repository_key: previous_repository_keys.first().cloned(),
        previous_repository_keys,
        repository_key: resolution.repository_key,
        display_name: resolution.display_name,
        availability: WorkspaceAvailability::Available,
        last_validated_at: crate::now_ms(),
        unavailable_reason: None,
        last_used_at: session.last_used_at,
    }
}

pub(crate) fn repository_key_matches(record: &ProjectAttachmentRecord, requested: &str) -> bool {
    let requested = requested.trim();
    !requested.is_empty()
        && (record.repository_key == requested
            || pending_repository_keys(record).contains(requested))
}

fn pending_repository_keys(session: &ProjectAttachmentRecord) -> BTreeSet<String> {
    session
        .previous_repository_keys
        .iter()
        .chain(session.previous_repository_key.iter())
        .filter(|key| !key.is_empty() && *key != &session.repository_key)
        .cloned()
        .collect()
}

fn set_pending_repository_keys(
    session: &mut ProjectAttachmentRecord,
    mut previous_repository_keys: BTreeSet<String>,
) -> bool {
    previous_repository_keys.remove(&session.repository_key);
    let previous_repository_key = previous_repository_keys.first().cloned();
    let previous_repository_keys = previous_repository_keys.into_iter().collect();
    let changed = session.previous_repository_key != previous_repository_key
        || session.previous_repository_keys != previous_repository_keys;
    session.previous_repository_key = previous_repository_key;
    session.previous_repository_keys = previous_repository_keys;
    changed
}

fn previous_repository_keys_after_resolve(
    session: &ProjectAttachmentRecord,
    new_key: &str,
) -> Vec<String> {
    let mut previous_repository_keys = pending_repository_keys(session);
    if !session.repository_key.is_empty() && session.repository_key != new_key {
        previous_repository_keys.insert(session.repository_key.clone());
    }
    previous_repository_keys.remove(new_key);
    previous_repository_keys.into_iter().collect()
}

fn mark_unavailable(
    session: ProjectAttachmentRecord,
    error: &anyhow::Error,
) -> ProjectAttachmentRecord {
    let fallback_name = directory_name(&session.workspace_path);
    let attachment_key = unavailable_attachment_key(&session);
    ProjectAttachmentRecord {
        availability: WorkspaceAvailability::Unavailable,
        last_validated_at: crate::now_ms(),
        unavailable_reason: Some(error.to_string()),
        repository_key: if session.repository_key.is_empty() {
            fallback_name.clone()
        } else {
            session.repository_key
        },
        display_name: if session.display_name.is_empty() {
            fallback_name
        } else {
            session.display_name
        },
        attachment_key,
        ..session
    }
}

fn unavailable_attachment_key(session: &ProjectAttachmentRecord) -> String {
    session.attachment_key.clone()
}

fn validate_session_path(session: ProjectAttachmentRecord) -> ProjectAttachmentRecord {
    match resolve_workspace_path(&session.workspace_path, false) {
        Ok(resolution) => mark_available(session, resolution),
        Err(error) => mark_unavailable(session, &error),
    }
}

fn session_record_changed(
    previous: &ProjectAttachmentRecord,
    current: &ProjectAttachmentRecord,
) -> bool {
    previous.workspace_path != current.workspace_path
        || previous.repository_key != current.repository_key
        || previous.attachment_key != current.attachment_key
        || previous.previous_repository_key != current.previous_repository_key
        || previous.previous_repository_keys != current.previous_repository_keys
        || previous.display_name != current.display_name
        || previous.availability != current.availability
        || previous.unavailable_reason != current.unavailable_reason
}

async fn validate_session_async(
    session: ProjectAttachmentRecord,
) -> Result<ProjectAttachmentRecord> {
    tokio::task::spawn_blocking(move || validate_session_path(session))
        .await
        .context("workspace validation task failed")
}

async fn resolve_attachment(workspace_path: String) -> Result<ProjectAttachmentRecord> {
    let now = crate::now_ms();
    let resolved = validate_session_async(ProjectAttachmentRecord {
        workspace_path,
        repository_key: String::new(),
        attachment_key: String::new(),
        display_name: String::new(),
        availability: WorkspaceAvailability::Available,
        last_validated_at: now,
        last_used_at: now,
        unavailable_reason: None,
        previous_repository_key: None,
        previous_repository_keys: Vec::new(),
    })
    .await?;

    if resolved.availability == WorkspaceAvailability::Unavailable {
        if let Some(reason) = &resolved.unavailable_reason {
            anyhow::bail!("{reason}");
        }
        anyhow::bail!("workspace path is unavailable");
    }
    Ok(resolved)
}

pub fn resolve_workspace_path(
    workspace_path: &str,
    create_if_missing: bool,
) -> Result<WorkspacePathResolution> {
    let root = if create_if_missing {
        resolve_or_create_workspace_root(workspace_path)?
    } else {
        resolve_workspace_root(workspace_path)?
    };
    let workspace_path = root.to_string_lossy().to_string();
    if workspace_path.is_empty() {
        anyhow::bail!("failed to resolve workspace path");
    }
    let identity = resolve_git_repository_identity(&root);

    Ok(WorkspacePathResolution {
        workspace_path,
        display_name: identity.display_name,
        repository_key: identity.repository_key,
        attachment_key: identity.attachment_key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn init_repo_with_origin(path: &std::path::Path, origin: &str) {
        fs::create_dir_all(path).expect("project dir");
        gix::init(path).expect("gix init");
        let config_path = path.join(".git/config");
        let mut config = fs::read_to_string(&config_path).expect("read config");
        config.push_str(&format!("\n[remote \"origin\"]\n\turl = {origin}\n"));
        fs::write(config_path, config).expect("write config");
    }

    fn attachment_record(
        workspace_path: impl Into<String>,
        repository_key: &str,
        last_used_at: u64,
    ) -> ProjectAttachmentRecord {
        ProjectAttachmentRecord {
            workspace_path: workspace_path.into(),
            repository_key: repository_key.into(),
            attachment_key: format!("remote:{repository_key}"),
            display_name: repository_key.into(),
            availability: WorkspaceAvailability::Available,
            last_validated_at: last_used_at,
            last_used_at,
            unavailable_reason: None,
            previous_repository_key: None,
            previous_repository_keys: Vec::new(),
        }
    }

    #[tokio::test]
    async fn attach_and_list_project_attachment() {
        let temp_root =
            std::env::temp_dir().join(format!("sprocket-project-attachments-{}", crate::now_ms()));
        fs::create_dir_all(&temp_root).expect("temp dir");
        let store = ProjectAttachmentStore::new(temp_root.clone());

        let session = store
            .attach(AttachProjectRequest {
                workspace_path: env!("CARGO_MANIFEST_DIR").to_string(),
                replace_workspace_path: None,
            })
            .await
            .expect("attach");

        assert_eq!(session.availability, WorkspaceAvailability::Available);
        assert!(!session.repository_key.is_empty());
        let listed = store.list().await.expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].workspace_path, session.workspace_path);

        let _ = fs::remove_dir_all(temp_root);
    }

    #[cfg(unix)]
    #[test]
    fn workspace_path_resolution_uses_canonical_name_and_root_fallback() {
        use std::os::unix::fs::symlink;

        let temp_root =
            std::env::temp_dir().join(format!("sprocket-workspace-path-{}", crate::now_ms()));
        let target = temp_root.join("real-project");
        let link = temp_root.join("project-link");
        fs::create_dir_all(&target).expect("target dir");
        symlink(&target, &link).expect("symlink");

        let linked = resolve_workspace_path(&link.to_string_lossy(), false).expect("linked path");
        assert_eq!(linked.workspace_path, target.to_string_lossy());
        assert_eq!(linked.display_name, "real-project");
        assert_eq!(linked.repository_key, "real-project");

        let root = resolve_workspace_path("/", false).expect("filesystem root");
        assert_eq!(root.display_name, "workspace");
        assert_eq!(root.repository_key, "workspace");

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn workspace_path_resolution_uses_git_origin_repository_key() {
        let temp_root =
            std::env::temp_dir().join(format!("sprocket-workspace-git-{}", crate::now_ms()));
        let project = temp_root.join("checkout");
        fs::create_dir_all(&project).expect("project dir");
        gix::init(&project).expect("gix init");
        let config_path = project.join(".git/config");
        let mut config = fs::read_to_string(&config_path).expect("read config");
        config
            .push_str("\n[remote \"origin\"]\n\turl = https://github.com/spikonado/sprocket.git\n");
        fs::write(config_path, config).expect("write config");

        let resolved =
            resolve_workspace_path(&project.to_string_lossy(), false).expect("resolve project");
        assert_eq!(resolved.display_name, "sprocket");
        assert_eq!(resolved.repository_key, "github.com/spikonado/sprocket");

        let _ = fs::remove_dir_all(temp_root);
    }

    #[tokio::test]
    async fn attach_replaces_the_previous_workspace_path() {
        let temp_root = std::env::temp_dir().join(format!(
            "sprocket-project-attachments-replace-{}",
            crate::now_ms()
        ));
        fs::create_dir_all(&temp_root).expect("temp dir");
        let store = ProjectAttachmentStore::new(temp_root.clone());
        let first = temp_root.join("first");
        let second = temp_root.join("second");
        fs::create_dir_all(&first).expect("first dir");
        fs::create_dir_all(&second).expect("second dir");

        let attached_first = store
            .attach(AttachProjectRequest {
                workspace_path: first.to_string_lossy().to_string(),
                replace_workspace_path: None,
            })
            .await
            .expect("attach first");
        let attached_second = store
            .attach(AttachProjectRequest {
                workspace_path: second.to_string_lossy().to_string(),
                replace_workspace_path: Some(attached_first.workspace_path.clone()),
            })
            .await
            .expect("attach second");

        let listed = store.list().await.expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].workspace_path, attached_second.workspace_path);

        let _ = fs::remove_dir_all(temp_root);
    }

    #[tokio::test]
    async fn attach_keeps_the_first_directory_for_a_repository() {
        let temp_root = tempfile::tempdir().expect("temp dir");
        let first = temp_root.path().join("main");
        let second = temp_root.path().join("feature");
        let origin = "https://github.com/spikonado/sprocket.git";
        init_repo_with_origin(&first, origin);
        init_repo_with_origin(&second, origin);
        let store = ProjectAttachmentStore::new(temp_root.path().to_path_buf());

        let attached_first = store
            .attach(AttachProjectRequest {
                workspace_path: first.to_string_lossy().to_string(),
                replace_workspace_path: None,
            })
            .await
            .expect("attach first worktree");
        let error = store
            .attach(AttachProjectRequest {
                workspace_path: second.to_string_lossy().to_string(),
                replace_workspace_path: None,
            })
            .await
            .expect_err("reject second worktree");

        let listed = store.list().await.expect("list");
        assert!(error.to_string().contains(&attached_first.workspace_path));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].workspace_path, attached_first.workspace_path);
        assert_eq!(listed[0].repository_key, attached_first.repository_key);
    }

    #[tokio::test]
    async fn attach_keeps_unrelated_directories_with_the_same_name() {
        let temp_root = tempfile::tempdir().expect("temp dir");
        let first = temp_root.path().join("clients/project");
        let second = temp_root.path().join("archive/project");
        fs::create_dir_all(&first).expect("first project");
        fs::create_dir_all(&second).expect("second project");
        let store = ProjectAttachmentStore::new(temp_root.path().to_path_buf());

        let attached_first = store
            .attach(AttachProjectRequest {
                workspace_path: first.to_string_lossy().to_string(),
                replace_workspace_path: None,
            })
            .await
            .expect("attach first project");
        let attached_second = store
            .attach(AttachProjectRequest {
                workspace_path: second.to_string_lossy().to_string(),
                replace_workspace_path: None,
            })
            .await
            .expect("attach second project");

        let listed = store.list().await.expect("list");
        assert_eq!(
            attached_first.repository_key,
            attached_second.repository_key
        );
        assert_ne!(
            attached_first.attachment_key,
            attached_second.attachment_key
        );
        assert_eq!(listed.len(), 2);
    }

    #[tokio::test]
    async fn explicit_reconnect_replaces_the_directory_for_a_repository() {
        let temp_root = tempfile::tempdir().expect("temp dir");
        let first = temp_root.path().join("main");
        let second = temp_root.path().join("feature");
        let origin = "https://github.com/spikonado/sprocket.git";
        init_repo_with_origin(&first, origin);
        init_repo_with_origin(&second, origin);
        let store = ProjectAttachmentStore::new(temp_root.path().to_path_buf());

        let attached_first = store
            .attach(AttachProjectRequest {
                workspace_path: first.to_string_lossy().to_string(),
                replace_workspace_path: None,
            })
            .await
            .expect("attach first worktree");
        let attached_second = store
            .attach(AttachProjectRequest {
                workspace_path: second.to_string_lossy().to_string(),
                replace_workspace_path: Some(attached_first.workspace_path),
            })
            .await
            .expect("reconnect to second worktree");

        let listed = store.list().await.expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].workspace_path, attached_second.workspace_path);
        assert_eq!(listed[0].repository_key, attached_second.repository_key);
    }

    #[tokio::test]
    async fn reconnect_rejects_a_repository_attached_at_another_path() {
        let temp_root = tempfile::tempdir().expect("temp dir");
        let first = temp_root.path().join("first");
        let second = temp_root.path().join("second");
        let duplicate_second = temp_root.path().join("duplicate-second");
        init_repo_with_origin(&first, "https://github.com/spikonado/first.git");
        init_repo_with_origin(&second, "https://github.com/spikonado/second.git");
        init_repo_with_origin(&duplicate_second, "https://github.com/spikonado/second.git");
        let store = ProjectAttachmentStore::new(temp_root.path().to_path_buf());

        let attached_first = store
            .attach(AttachProjectRequest {
                workspace_path: first.to_string_lossy().to_string(),
                replace_workspace_path: None,
            })
            .await
            .expect("attach first repository");
        let attached_second = store
            .attach(AttachProjectRequest {
                workspace_path: second.to_string_lossy().to_string(),
                replace_workspace_path: None,
            })
            .await
            .expect("attach second repository");

        let error = store
            .attach(AttachProjectRequest {
                workspace_path: duplicate_second.to_string_lossy().to_string(),
                replace_workspace_path: Some(attached_first.workspace_path.clone()),
            })
            .await
            .expect_err("reject already attached replacement repository");

        let listed = store.list().await.expect("list");
        assert!(error.to_string().contains(&attached_second.workspace_path));
        assert_eq!(listed.len(), 2);
        assert!(
            listed
                .iter()
                .any(|attachment| attachment.workspace_path == attached_first.workspace_path)
        );
        assert!(
            listed
                .iter()
                .any(|attachment| attachment.workspace_path == attached_second.workspace_path)
        );
    }

    #[tokio::test]
    async fn run_workspace_does_not_replace_the_first_attached_directory() {
        let temp_root = tempfile::tempdir().expect("temp dir");
        let first = temp_root.path().join("main");
        let second = temp_root.path().join("feature");
        let origin = "https://github.com/spikonado/sprocket.git";
        init_repo_with_origin(&first, origin);
        init_repo_with_origin(&second, origin);
        let store = ProjectAttachmentStore::new(temp_root.path().to_path_buf());

        let attached_first = store
            .resolve_run_workspace(first.to_string_lossy().to_string())
            .await
            .expect("resolve first worktree");
        let resolved_second = store
            .resolve_run_workspace(second.to_string_lossy().to_string())
            .await
            .expect("resolve second worktree");

        let listed = store.list().await.expect("list");
        assert_eq!(resolved_second.workspace_path, second.to_string_lossy());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].workspace_path, attached_first.workspace_path);
    }

    #[tokio::test]
    async fn list_migrates_duplicate_repository_attachments() {
        let temp_root = tempfile::tempdir().expect("temp dir");
        let first = temp_root.path().join("main");
        let second = temp_root.path().join("feature");
        let origin = "https://github.com/spikonado/sprocket.git";
        init_repo_with_origin(&first, origin);
        init_repo_with_origin(&second, origin);
        fs::write(
            temp_root.path().join(PROJECT_ATTACHMENTS_FILE),
            serde_json::to_string(&vec![
                attachment_record(first.to_string_lossy(), "github.com/spikonado/sprocket", 1),
                attachment_record(second.to_string_lossy(), "github.com/spikonado/sprocket", 2),
            ])
            .expect("serialize attachments"),
        )
        .expect("write attachments");

        let listed = ProjectAttachmentStore::new(temp_root.path().to_path_buf())
            .list()
            .await
            .expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].workspace_path, first.to_string_lossy());

        let persisted: Vec<ProjectAttachmentRecord> = serde_json::from_str(
            &fs::read_to_string(temp_root.path().join(PROJECT_ATTACHMENTS_FILE))
                .expect("read attachments"),
        )
        .expect("parse attachments");
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].workspace_path, first.to_string_lossy());
    }

    #[tokio::test]
    async fn list_deduplicates_an_unavailable_duplicate() {
        let temp_root = tempfile::tempdir().expect("temp dir");
        let missing = temp_root.path().join("removed");
        let available = temp_root.path().join("current");
        let repository_key = "github.com/spikonado/sprocket";
        init_repo_with_origin(&available, "https://github.com/spikonado/sprocket.git");
        let mut missing_record = attachment_record(missing.to_string_lossy(), repository_key, 1);
        missing_record.display_name = "sprocket".to_string();
        let mut available_record =
            attachment_record(available.to_string_lossy(), repository_key, 2);
        available_record.display_name = "sprocket".to_string();
        fs::write(
            temp_root.path().join(PROJECT_ATTACHMENTS_FILE),
            serde_json::to_string(&vec![missing_record, available_record])
                .expect("serialize attachments"),
        )
        .expect("write attachments");

        let listed = ProjectAttachmentStore::new(temp_root.path().to_path_buf())
            .list()
            .await
            .expect("list");

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].workspace_path, available.to_string_lossy());
        assert_eq!(listed[0].availability, WorkspaceAvailability::Available);
    }

    #[tokio::test]
    async fn list_deduplicates_a_single_component_remote_duplicate() {
        let temp_root = tempfile::tempdir().expect("temp dir");
        let missing = temp_root.path().join("removed");
        let available = temp_root.path().join("current");
        init_repo_with_origin(&available, "sprocket.git");
        let mut missing_record = attachment_record(missing.to_string_lossy(), "sprocket", 1);
        missing_record.display_name = "sprocket".to_string();
        let mut available_record = attachment_record(available.to_string_lossy(), "sprocket", 2);
        available_record.display_name = "sprocket".to_string();
        fs::write(
            temp_root.path().join(PROJECT_ATTACHMENTS_FILE),
            serde_json::to_string(&vec![missing_record, available_record])
                .expect("serialize attachments"),
        )
        .expect("write attachments");

        let listed = ProjectAttachmentStore::new(temp_root.path().to_path_buf())
            .list()
            .await
            .expect("list");

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].workspace_path, available.to_string_lossy());
        assert_eq!(listed[0].attachment_key, "remote:sprocket");
    }

    #[tokio::test]
    async fn list_keeps_local_directories_that_match_a_remote_key() {
        let temp_root = tempfile::tempdir().expect("temp dir");
        let first = temp_root.path().join("clients/project");
        let second = temp_root.path().join("archive/project");
        let remote = temp_root.path().join("current");
        init_repo_with_origin(&remote, "project.git");
        let mut first_record = attachment_record(first.to_string_lossy(), "project", 1);
        first_record.attachment_key = format!("directory:{}", first.to_string_lossy());
        first_record.display_name = "project".to_string();
        let mut second_record = attachment_record(second.to_string_lossy(), "project", 2);
        second_record.attachment_key = format!("directory:{}", second.to_string_lossy());
        second_record.display_name = "project".to_string();
        let mut remote_record = attachment_record(remote.to_string_lossy(), "project", 3);
        remote_record.display_name = "project".to_string();
        fs::write(
            temp_root.path().join(PROJECT_ATTACHMENTS_FILE),
            serde_json::to_string(&vec![first_record, second_record, remote_record])
                .expect("serialize attachments"),
        )
        .expect("write attachments");

        let listed = ProjectAttachmentStore::new(temp_root.path().to_path_buf())
            .list()
            .await
            .expect("list");

        assert_eq!(listed.len(), 3);
        assert_eq!(
            listed
                .iter()
                .filter(|attachment| {
                    attachment.availability == WorkspaceAvailability::Unavailable
                        && attachment.attachment_key
                            == format!("directory:{}", attachment.workspace_path)
                })
                .count(),
            2
        );
        assert!(listed.iter().any(|attachment| {
            attachment.availability == WorkspaceAvailability::Available
                && attachment.attachment_key == "remote:project"
        }));
    }

    #[test]
    fn duplicate_winner_does_not_depend_on_hash_map_order() {
        let earlier = attachment_record("/worktrees/earlier", "repository", 1);
        let lexical_tie = attachment_record("/worktrees/a-first", "repository", 1);
        let later = attachment_record("/worktrees/later", "repository", 1);

        for records in [
            [&earlier, &lexical_tie, &later],
            [&later, &earlier, &lexical_tie],
        ] {
            let mut attachments = records
                .into_iter()
                .map(|record| (record.workspace_path.clone(), record.clone()))
                .collect();

            assert!(deduplicate_repository_attachments(&mut attachments, None));
            assert_eq!(
                attachments.keys().collect::<Vec<_>>(),
                vec![&lexical_tie.workspace_path]
            );
        }
    }

    #[tokio::test]
    async fn list_keeps_the_previous_repository_key_when_git_identity_changes() {
        let temp_root = std::env::temp_dir().join(format!(
            "sprocket-project-attachments-rekey-{}",
            crate::now_ms()
        ));
        fs::create_dir_all(&temp_root).expect("temp dir");
        let workspace = temp_root.join("checkout");
        fs::create_dir_all(&workspace).expect("workspace dir");
        gix::init(&workspace).expect("gix init");
        let config_path = workspace.join(".git/config");
        let mut config = fs::read_to_string(&config_path).expect("read config");
        config
            .push_str("\n[remote \"origin\"]\n\turl = https://github.com/spikonado/sprocket.git\n");
        fs::write(config_path, config).expect("write config");
        fs::write(
            temp_root.join(PROJECT_ATTACHMENTS_FILE),
            serde_json::json!([{
                "workspacePath": workspace.to_string_lossy(),
                "repositoryKey": "previous-key",
                "attachmentKey": "remote:previous-key",
                "displayName": "checkout",
                "availability": "available",
                "lastValidatedAt": 1,
                "lastUsedAt": 2
            }])
            .to_string(),
        )
        .expect("write attachments");

        let listed = ProjectAttachmentStore::new(temp_root.clone())
            .list()
            .await
            .expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].repository_key, "github.com/spikonado/sprocket");
        assert_eq!(
            listed[0].previous_repository_key.as_deref(),
            Some("previous-key")
        );
        assert_eq!(listed[0].previous_repository_keys, ["previous-key"]);

        let _ = fs::remove_dir_all(temp_root);
    }

    #[tokio::test]
    async fn list_keeps_a_pending_rekey_when_remote_change_creates_a_duplicate() {
        let temp_root = tempfile::tempdir().expect("temp dir");
        let changed = temp_root.path().join("changed");
        let existing = temp_root.path().join("existing");
        let new_repository_key = "github.com/spikonado/sprocket";
        let old_repository_key = "github.com/spikonado/old-sprocket";
        let origin = "https://github.com/spikonado/sprocket.git";
        init_repo_with_origin(&changed, origin);
        init_repo_with_origin(&existing, origin);

        fs::write(
            temp_root.path().join(PROJECT_ATTACHMENTS_FILE),
            serde_json::to_string(&vec![
                attachment_record(changed.to_string_lossy(), old_repository_key, 2),
                attachment_record(existing.to_string_lossy(), new_repository_key, 1),
            ])
            .expect("serialize attachments"),
        )
        .expect("write attachments");

        let listed = ProjectAttachmentStore::new(temp_root.path().to_path_buf())
            .list()
            .await
            .expect("list");

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].workspace_path, existing.to_string_lossy());
        assert_eq!(listed[0].repository_key, new_repository_key);
        assert_eq!(
            listed[0].previous_repository_key.as_deref(),
            Some(old_repository_key)
        );
        assert_eq!(listed[0].previous_repository_keys, [old_repository_key]);
    }

    #[tokio::test]
    async fn list_keeps_all_pending_rekeys_when_changed_remotes_converge() {
        let temp_root = tempfile::tempdir().expect("temp dir");
        let first = temp_root.path().join("first");
        let second = temp_root.path().join("second");
        let existing = temp_root.path().join("existing");
        let new_repository_key = "github.com/spikonado/sprocket";
        let origin = "https://github.com/spikonado/sprocket.git";
        init_repo_with_origin(&first, origin);
        init_repo_with_origin(&second, origin);
        init_repo_with_origin(&existing, origin);

        fs::write(
            temp_root.path().join(PROJECT_ATTACHMENTS_FILE),
            serde_json::to_string(&vec![
                attachment_record(first.to_string_lossy(), "github.com/spikonado/first", 2),
                attachment_record(second.to_string_lossy(), "github.com/spikonado/second", 3),
                attachment_record(existing.to_string_lossy(), new_repository_key, 1),
            ])
            .expect("serialize attachments"),
        )
        .expect("write attachments");

        let listed = ProjectAttachmentStore::new(temp_root.path().to_path_buf())
            .list()
            .await
            .expect("list");

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].workspace_path, existing.to_string_lossy());
        assert_eq!(
            listed[0].previous_repository_key.as_deref(),
            Some("github.com/spikonado/first")
        );
        assert_eq!(
            listed[0].previous_repository_keys,
            ["github.com/spikonado/first", "github.com/spikonado/second"]
        );
        assert!(repository_key_matches(
            &listed[0],
            "github.com/spikonado/first"
        ));
        assert!(repository_key_matches(
            &listed[0],
            "github.com/spikonado/second"
        ));
    }
}
