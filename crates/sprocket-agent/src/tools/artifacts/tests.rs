use super::*;

#[test]
fn summaries_keep_file_identity_without_copying_content_into_tool_history() {
    assert_eq!(
        artifact_summary(json!({
            "_id": "id",
            "content": "large body",
            "userId": "user",
            "threadId": "thread",
            "type": "markdown",
            "title": "doc.md",
            "revision": 3,
            "_creationTime": 1,
            "localPath": "doc.md",
            "scope": "project"
        })),
        json!({"artifactId": "id", "type": "markdown", "title": "doc.md", "revision": 3})
    );
    assert_eq!(
        artifact_summary(json!({
            "artifactId": "id",
            "revision": 2,
            "title": "doc.md",
            "contentType": "markdown",
            "localPath": "doc.md",
            "scope": "thread",
            "content": "body"
        })),
        json!({"artifactId": "id", "title": "doc.md", "revision": 2, "contentType": "markdown"})
    );
}
