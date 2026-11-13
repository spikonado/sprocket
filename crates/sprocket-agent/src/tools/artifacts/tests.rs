use super::*;

#[test]
fn source_paths_are_normalized_relative_to_the_project() {
    let root = tempfile::tempdir().unwrap();
    for path in ["docs/note.md", "./docs/note.md", "docs/draft/../note.md"] {
        assert_eq!(
            artifact_source_path(root.path(), path).as_deref(),
            Some("docs/note.md")
        );
    }
    assert_eq!(
        artifact_source_path(
            root.path(),
            root.path().join("docs/note.md").to_str().unwrap()
        )
        .as_deref(),
        Some("docs/note.md")
    );
    assert_eq!(artifact_source_path(root.path(), "../note.md"), None);
    let external = tempfile::tempdir().unwrap();
    assert_eq!(
        artifact_source_path(
            root.path(),
            external.path().join("note.md").to_str().unwrap()
        ),
        None
    );
}

#[test]
fn summaries_add_absolute_paths_for_artifacts_bound_on_this_machine() {
    let listed = |id: &str| ListedArtifact {
        artifact_id: id.into(),
        title: "doc.md".into(),
    };
    let bindings = [ArtifactBinding {
        registration_id: "registration".into(),
        artifact_id: Some("bound".into()),
        local_path: "docs/doc.md".into(),
        content_hash: String::new(),
    }];
    let root = Path::new("/workspace");
    assert_eq!(
        artifact_summary(listed("bound"), &bindings, root),
        json!({"artifactId": "bound", "title": "doc.md", "path": "/workspace/docs/doc.md"})
    );
    assert_eq!(
        artifact_summary(listed("cloud"), &bindings, root),
        json!({"artifactId": "cloud", "title": "doc.md"})
    );
}
