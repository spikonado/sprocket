use super::*;

#[test]
fn summaries_add_absolute_paths_for_artifacts_bound_on_this_machine() {
    let listed = |id: &str| ListedArtifact {
        artifact_id: id.into(),
        title: "doc.md".into(),
        updated_at: json!(3),
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
        json!({"artifactId": "bound", "title": "doc.md", "updatedAt": 3, "path": "/workspace/docs/doc.md"})
    );
    assert_eq!(
        artifact_summary(listed("cloud"), &bindings, root),
        json!({"artifactId": "cloud", "title": "doc.md", "updatedAt": 3})
    );
}
