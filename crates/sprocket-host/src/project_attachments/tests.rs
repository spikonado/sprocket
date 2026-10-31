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
        last_message_sent_at: 0,
        unavailable_reason: None,
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

#[tokio::test]
async fn removed_project_stays_removed_until_a_run_uses_its_folder() {
    let data_dir = tempfile::tempdir().expect("data dir");
    let project = tempfile::tempdir().expect("project dir");
    let store = ProjectAttachmentStore::new(data_dir.path().to_path_buf());
    let attached = store
        .attach(AttachProjectRequest {
            workspace_path: project.path().to_string_lossy().into_owned(),
            replace_workspace_path: None,
        })
        .await
        .expect("attach");

    store
        .remove(&attached.workspace_path)
        .await
        .expect("remove");

    let reloaded = ProjectAttachmentStore::new(data_dir.path().to_path_buf());
    assert!(reloaded.list().await.expect("list").is_empty());
    assert!(project.path().exists());

    reloaded
        .resolve_run_workspace(attached.workspace_path.clone())
        .await
        .expect("resolve run workspace");
    let listed = reloaded.list().await.expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].workspace_path, attached.workspace_path);
}

#[tokio::test]
async fn message_recency_survives_reload_validation_and_reconnect() {
    let temp_root = tempfile::tempdir().expect("temp dir");
    let alpha = temp_root.path().join("alpha");
    let beta = temp_root.path().join("beta");
    let beta_worktree = temp_root.path().join("beta-worktree");
    init_repo_with_origin(&alpha, "https://github.com/example/alpha.git");
    init_repo_with_origin(&beta, "https://github.com/example/beta.git");
    init_repo_with_origin(&beta_worktree, "https://github.com/example/beta.git");
    let store = ProjectAttachmentStore::new(temp_root.path().to_path_buf());
    let attached_alpha = store
        .attach(AttachProjectRequest {
            workspace_path: alpha.to_string_lossy().into_owned(),
            replace_workspace_path: None,
        })
        .await
        .expect("attach alpha");
    let attached_beta = store
        .attach(AttachProjectRequest {
            workspace_path: beta.to_string_lossy().into_owned(),
            replace_workspace_path: None,
        })
        .await
        .expect("attach beta");
    store
        .record_message_sent(&attached_alpha.attachment_key, 100)
        .await
        .expect("send to alpha");
    store
        .record_message_sent(&attached_beta.attachment_key, 200)
        .await
        .expect("send to beta");
    store
        .record_message_sent(&attached_beta.attachment_key, 150)
        .await
        .expect("late acknowledgement of an earlier send");

    store
        .attach(AttachProjectRequest {
            workspace_path: attached_alpha.workspace_path.clone(),
            replace_workspace_path: None,
        })
        .await
        .expect("reopen alpha");
    let resolved_beta = store
        .resolve_run_workspace(beta_worktree.to_string_lossy().into_owned())
        .await
        .expect("resolve beta worktree");
    assert_eq!(resolved_beta.last_message_sent_at, 200);
    let reconnected_beta = store
        .attach(AttachProjectRequest {
            workspace_path: beta_worktree.to_string_lossy().into_owned(),
            replace_workspace_path: Some(attached_beta.workspace_path),
        })
        .await
        .expect("reconnect beta");

    let listed = ProjectAttachmentStore::new(temp_root.path().to_path_buf())
        .list()
        .await
        .expect("reload and validate attachments");
    assert_eq!(listed[0].workspace_path, reconnected_beta.workspace_path);
    assert_eq!(listed[0].last_message_sent_at, 200);
    assert_eq!(listed[1].workspace_path, attached_alpha.workspace_path);
    assert_eq!(listed[1].last_message_sent_at, 100);
}

#[tokio::test]
async fn legacy_attachments_gain_message_recency_with_stable_fallback_ordering() {
    let temp_root = tempfile::tempdir().expect("temp dir");
    let alpha = temp_root.path().join("alpha");
    let beta = temp_root.path().join("beta");
    init_repo_with_origin(&alpha, "https://github.com/example/alpha.git");
    init_repo_with_origin(&beta, "https://github.com/example/beta.git");
    let mut records = serde_json::to_value(vec![
        attachment_record(alpha.to_string_lossy(), "github.com/example/alpha", 1),
        attachment_record(beta.to_string_lossy(), "github.com/example/beta", 2),
    ])
    .expect("serialize legacy records");
    for record in records.as_array_mut().expect("records array") {
        record
            .as_object_mut()
            .expect("record object")
            .remove("lastMessageSentAt");
    }
    let store_path = temp_root.path().join(PROJECT_ATTACHMENTS_FILE);
    fs::write(
        &store_path,
        serde_json::to_vec(&records).expect("legacy JSON"),
    )
    .expect("write legacy records");

    let store = ProjectAttachmentStore::new(temp_root.path().to_path_buf());
    let listed = store.list().await.expect("load legacy records");
    assert_eq!(listed[0].workspace_path, beta.to_string_lossy());
    let persisted: Vec<serde_json::Value> =
        serde_json::from_slice(&fs::read(&store_path).expect("read migrated records"))
            .expect("parse migrated records");
    assert!(persisted.iter().all(|record| {
        record
            .get("lastMessageSentAt")
            .and_then(serde_json::Value::as_u64)
            == Some(0)
    }));

    store
        .record_message_sent(&listed[1].attachment_key, 10)
        .await
        .expect("record alpha message");
    assert_eq!(
        store.list().await.expect("ordered records")[0].workspace_path,
        alpha.to_string_lossy()
    );
}

#[tokio::test]
async fn newly_attached_project_survives_retention_after_older_projects_sent_messages() {
    let temp_root = tempfile::tempdir().expect("temp dir");
    let store = ProjectAttachmentStore::new(temp_root.path().to_path_buf());
    store.ensure_loaded().await.expect("load store");
    {
        let mut attachments = store.attachments.write().await;
        for index in 0..MAX_PERSISTED_PROJECT_ATTACHMENTS {
            let mut record = attachment_record(
                temp_root
                    .path()
                    .join(format!("old-{index}"))
                    .to_string_lossy(),
                &format!("old-{index}"),
                index as u64 + 1,
            );
            record.last_message_sent_at = 500;
            attachments.insert(record.workspace_path.clone(), record);
        }
    }
    let workspace = temp_root.path().join("new-project");
    fs::create_dir_all(&workspace).expect("create new project");
    let attached = store
        .attach(AttachProjectRequest {
            workspace_path: workspace.to_string_lossy().into_owned(),
            replace_workspace_path: None,
        })
        .await
        .expect("attach new project");

    let persisted: Vec<ProjectAttachmentRecord> = serde_json::from_slice(
        &fs::read(temp_root.path().join(PROJECT_ATTACHMENTS_FILE)).expect("read records"),
    )
    .expect("parse records");
    assert_eq!(persisted.len(), MAX_PERSISTED_PROJECT_ATTACHMENTS);
    assert!(persisted.contains(&attached));
    assert_eq!(
        store
            .get_or_error(&attached.workspace_path)
            .await
            .expect("retained project"),
        attached
    );
}

#[tokio::test]
async fn reattachment_and_run_resolution_preserve_send_time_after_origin_changes() {
    for resolve_run in [false, true] {
        let temp_root = tempfile::tempdir().expect("temp dir");
        let workspace = temp_root.path().join("checkout");
        let old_origin = "https://github.com/example/old.git";
        let new_origin = "https://github.com/example/new.git";
        init_repo_with_origin(&workspace, old_origin);
        let store = ProjectAttachmentStore::new(temp_root.path().to_path_buf());
        let attached = store
            .attach(AttachProjectRequest {
                workspace_path: workspace.to_string_lossy().into_owned(),
                replace_workspace_path: None,
            })
            .await
            .expect("attach project");
        store
            .record_message_sent(&attached.attachment_key, 200)
            .await
            .expect("record send");
        let config_path = workspace.join(".git/config");
        let config = fs::read_to_string(&config_path).expect("read config");
        fs::write(&config_path, config.replace(old_origin, new_origin)).expect("change origin");

        let refreshed = if resolve_run {
            store
                .resolve_run_workspace(attached.workspace_path.clone())
                .await
                .expect("resolve run")
        } else {
            store
                .attach(AttachProjectRequest {
                    workspace_path: attached.workspace_path.clone(),
                    replace_workspace_path: None,
                })
                .await
                .expect("reattach project")
        };
        assert_eq!(refreshed.repository_key, "github.com/example/new");
        assert_eq!(refreshed.last_message_sent_at, 200);
        let reloaded = ProjectAttachmentStore::new(temp_root.path().to_path_buf())
            .list()
            .await
            .expect("reload projects");
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0].last_message_sent_at, 200);
    }
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
    config.push_str("\n[remote \"origin\"]\n\turl = https://github.com/spikonado/sprocket.git\n");
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
    let mut available_record = attachment_record(available.to_string_lossy(), repository_key, 2);
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
async fn list_replaces_the_repository_key_when_git_identity_changes() {
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
    config.push_str("\n[remote \"origin\"]\n\turl = https://github.com/spikonado/sprocket.git\n");
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
            "lastUsedAt": 2,
            "previousRepositoryKey": "older-key"
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
    assert!(!repository_key_matches(&listed[0], "previous-key"));
    assert!(repository_key_matches(
        &listed[0],
        "github.com/spikonado/sprocket"
    ));

    let persisted: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(temp_root.join(PROJECT_ATTACHMENTS_FILE)).expect("read attachments"),
    )
    .expect("parse attachments");
    assert_eq!(persisted[0].get("previousRepositoryKey"), None);

    let _ = fs::remove_dir_all(temp_root);
}
