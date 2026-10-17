use super::*;

#[tokio::test]
async fn deletion_removes_local_files_and_bindings_and_allows_readding() {
    let dir = tempfile::tempdir().unwrap();
    let store = ArtifactBindings::new(&dir.path().join("data"), "deployment", "alice", dir.path());
    save_new_file(dir.path(), "notes.md", "source")
        .await
        .unwrap();
    let mut guard = store.lock().await.unwrap();
    let binding = guard.reserve("notes.md".into());
    binding.artifact_id = Some("deleted".into());
    let old_registration = binding.registration_id.clone();
    let pending_registration = guard.reserve("pending.md".into()).registration_id.clone();
    guard.persist().await.unwrap();
    guard.delete_artifact(dir.path(), "deleted").await.unwrap();
    guard.delete_artifact(dir.path(), "deleted").await.unwrap();
    drop(guard);
    let mut guard = store.lock().await.unwrap();
    assert!(guard.get("deleted").is_none());
    assert!(
        guard
            .bindings
            .iter()
            .any(|binding| binding.registration_id == pending_registration)
    );
    assert_ne!(
        guard.reserve("notes.md".into()).registration_id,
        old_registration
    );
    assert!(!dir.path().join("notes.md").exists());
}

#[tokio::test]
async fn deletion_handles_absolute_paths_and_already_missing_files() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let path = outside.path().join("notes.md");
    std::fs::write(&path, "source").unwrap();
    let store = ArtifactBindings::new(&dir.path().join("data"), "deployment", "alice", dir.path());
    let mut guard = store.lock().await.unwrap();
    for (id, path) in [
        ("absolute", path.to_str().unwrap()),
        ("missing", "missing.md"),
    ] {
        guard.reserve(path.into()).artifact_id = Some(id.into());
    }
    guard.persist().await.unwrap();
    guard.delete_artifact(dir.path(), "absolute").await.unwrap();
    guard.delete_artifact(dir.path(), "missing").await.unwrap();
    drop(guard);
    assert!(!path.exists());
    assert!(store.snapshot().await.unwrap().is_empty());
}

#[tokio::test]
async fn deletion_failure_keeps_the_binding_and_does_not_remove_directories() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.md");
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("keep.md"), "source").unwrap();
    let store = ArtifactBindings::new(&dir.path().join("data"), "deployment", "alice", dir.path());
    let mut guard = store.lock().await.unwrap();
    guard.reserve("notes.md".into()).artifact_id = Some("artifact".into());
    guard.persist().await.unwrap();
    assert!(guard.delete_artifact(dir.path(), "artifact").await.is_err());
    assert!(guard.get("artifact").is_some());
    drop(guard);
    assert_eq!(store.snapshot().await.unwrap().len(), 1);
    assert_eq!(
        std::fs::read_to_string(path.join("keep.md")).unwrap(),
        "source"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn deletion_unlinks_a_registered_symlink_without_deleting_its_target() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("target.md"), "source").unwrap();
    let link = dir.path().join("notes.md");
    std::os::unix::fs::symlink("target.md", &link).unwrap();
    let store = ArtifactBindings::new(&dir.path().join("data"), "deployment", "alice", dir.path());
    let mut guard = store.lock().await.unwrap();
    guard.reserve("notes.md".into()).artifact_id = Some("artifact".into());
    guard.delete_artifact(dir.path(), "artifact").await.unwrap();
    assert!(std::fs::symlink_metadata(link).is_err());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("target.md")).unwrap(),
        "source"
    );
}

#[tokio::test]
async fn legacy_bindings_migrate_without_merging_colliding_files() {
    let dir = tempfile::tempdir().unwrap();
    let store = ArtifactBindings::new(&dir.path().join("data"), "deployment", "alice", dir.path());
    tokio::fs::create_dir_all(&store.directory).await.unwrap();
    save_new_file(dir.path(), "notes.md", "untouched")
        .await
        .unwrap();
    let legacy = serde_json::json!([
        {"registration_id": "first-registration", "artifact_id": "first", "scope": "project",
         "thread_id": null, "local_path": "notes.md", "content_hash": "first-baseline"},
        {"registration_id": "second-registration", "artifact_id": "second", "scope": "thread",
         "thread_id": "old-thread", "local_path": "./notes.md", "content_hash": "second-baseline"}
    ]);
    tokio::fs::write(
        store.directory.join("bindings.json"),
        serde_json::to_vec(&legacy).unwrap(),
    )
    .await
    .unwrap();
    let mut guard = store.lock().await.unwrap();
    assert_eq!(guard.bindings.len(), 2);
    assert_eq!(guard.get("first").unwrap().content_hash, "first-baseline");
    assert_eq!(
        guard.get("second").unwrap().registration_id,
        "second-registration"
    );
    assert_eq!(
        conflicting_binding_ids(dir.path(), &guard.bindings)
            .await
            .len(),
        2
    );
    assert!(guard.at_path(dir.path(), "notes.md").await.is_err());
    assert!(guard.delete_artifact(dir.path(), "first").await.is_err());
    assert!(guard.get("first").is_some());
    assert!(guard.get("second").is_some());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("notes.md")).unwrap(),
        "untouched"
    );
    assert!(
        guard
            .validate_destination(dir.path(), guard.get("second").unwrap())
            .await
            .is_err()
    );
    let persisted: Vec<serde_json::Value> = serde_json::from_slice(
        &tokio::fs::read(store.directory.join("bindings.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(
        persisted
            .iter()
            .all(|row| row.get("scope").is_none() && row.get("thread_id").is_none())
    );
    let mut rebound = guard.get("second").unwrap().clone();
    rebound.local_path = "second.md".into();
    save_new_file(dir.path(), &rebound.local_path, "second artifact")
        .await
        .unwrap();
    guard
        .validate_destination(dir.path(), &rebound)
        .await
        .unwrap();
    guard.bind(rebound).unwrap();
    guard.persist().await.unwrap();
    assert!(
        conflicting_binding_ids(dir.path(), &guard.bindings)
            .await
            .is_empty()
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("notes.md")).unwrap(),
        "untouched"
    );
    guard.delete_artifact(dir.path(), "first").await.unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.path().join("second.md")).unwrap(),
        "second artifact"
    );
    drop(guard);
    let guard = store.lock().await.unwrap();
    assert_eq!(guard.bindings.len(), 1);
    assert_eq!(guard.get("second").unwrap().local_path, "second.md");
}

#[tokio::test]
async fn bindings_survive_restart_and_are_isolated_and_locked() {
    let dir = tempfile::tempdir().unwrap();
    let store = ArtifactBindings::new(dir.path(), "deployment", "alice", Path::new("/ws"));
    let mut guard = store.lock().await.unwrap();
    let entry = guard.reserve("notes.md".into());
    entry.artifact_id = Some("artifact".into());
    entry.content_hash = content_hash("hello");
    guard.persist().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), store.lock())
            .await
            .is_err()
    );
    drop(guard);
    let reopened = ArtifactBindings::new(dir.path(), "deployment", "alice", Path::new("/ws"));
    assert_eq!(
        reopened
            .lock()
            .await
            .unwrap()
            .get("artifact")
            .unwrap()
            .local_path,
        "notes.md"
    );
    for (deployment, user, workspace) in [
        ("other", "alice", "/ws"),
        ("deployment", "bob", "/ws"),
        ("deployment", "alice", "/other"),
    ] {
        assert!(
            ArtifactBindings::new(dir.path(), deployment, user, Path::new(workspace))
                .lock()
                .await
                .unwrap()
                .bindings
                .is_empty()
        );
    }
}

#[tokio::test]
async fn saves_relative_and_absolute_paths_without_overwriting() {
    let dir = tempfile::tempdir().unwrap();
    save_new_file(dir.path(), "nested/doc.md", "hello")
        .await
        .unwrap();
    save_new_file(dir.path(), "nested/doc.md", "hello")
        .await
        .unwrap();
    assert!(
        save_new_file(dir.path(), "nested/doc.md", "changed")
            .await
            .is_err()
    );
    let path = dir.path().join("absolute.md");
    save_new_file(Path::new("/unused"), path.to_str().unwrap(), "absolute")
        .await
        .unwrap();
    assert_eq!(
        tokio::fs::read_to_string(dir.path().join("nested/doc.md"))
            .await
            .unwrap(),
        "hello"
    );
}

#[tokio::test]
async fn equivalent_paths_cannot_bind_different_artifacts() {
    let dir = tempfile::tempdir().unwrap();
    let store = ArtifactBindings::new(&dir.path().join("data"), "deployment", "alice", dir.path());
    save_new_file(dir.path(), "doc.md", "hello").await.unwrap();
    let mut guard = store.lock().await.unwrap();
    let mut binding = guard.reserve("doc.md".into()).clone();
    binding.artifact_id = Some("first".into());
    guard.bind(binding.clone()).unwrap();
    binding.artifact_id = Some("second".into());
    for path in [
        "./doc.md".to_string(),
        dir.path().join("doc.md").to_str().unwrap().to_string(),
    ] {
        binding.local_path = path;
        assert!(
            guard
                .validate_destination(dir.path(), &binding)
                .await
                .is_err()
        );
    }
}
