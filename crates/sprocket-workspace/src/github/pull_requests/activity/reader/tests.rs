use super::*;

#[test]
fn reads_check_outcomes_and_required_flags() {
    let data: CoreData = serde_json::from_value(json!({
        "viewer": { "login": "me" },
        "repository": { "pullRequest": {
            "state": "OPEN",
            "mergeable": "UNKNOWN",
            "headRefOid": "a1",
            "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "contexts": {
                "nodes": [
                    { "__typename": "CheckRun", "name": "rust", "status": "COMPLETED", "conclusion": "TIMED_OUT", "detailsUrl": "https://ci/rust", "isRequired": true },
                    { "__typename": "CheckRun", "name": "docs", "status": "COMPLETED", "conclusion": "SKIPPED", "detailsUrl": null, "isRequired": false },
                    { "__typename": "StatusContext", "context": "deploy", "state": "PENDING", "targetUrl": null }
                ],
                "pageInfo": { "hasNextPage": true, "endCursor": "c1" }
            } } } }] }
        } }
    }))
    .unwrap();

    let mut checks = Vec::new();
    let after = data
        .repository
        .unwrap()
        .pull_request
        .unwrap()
        .commits
        .read_contexts(&mut checks);

    assert_eq!(after.as_deref(), Some("c1"));
    let read: Vec<_> = checks
        .iter()
        .map(|check| (check.name.as_str(), check.outcome, check.required))
        .collect();
    assert_eq!(
        read,
        [
            ("rust", CheckOutcome::Failed, true),
            ("docs", CheckOutcome::Passed, false),
            ("deploy", CheckOutcome::Pending, false),
        ]
    );
}

#[test]
fn turns_reviews_and_comments_into_remarks() {
    let review: ReviewNode = serde_json::from_value(json!({
        "id": "r1", "author": { "login": "review-bot" }, "state": "APPROVED", "body": "<!-- meta -->",
        "submittedAt": "2026-01-01T00:02:00Z", "lastEditedAt": null, "url": "u1"
    }))
    .unwrap();
    let draft: ReviewNode = serde_json::from_value(json!({
        "id": "r2", "author": { "login": "me" }, "state": "PENDING", "body": "Draft",
        "submittedAt": null, "lastEditedAt": null, "url": "u2"
    }))
    .unwrap();
    let comment: CommentNode = serde_json::from_value(json!({
        "id": "c1", "author": null,
        "body": "<a href=\"#\"><img alt=\"P1\" src=\"x.svg\"></a> Use `Vec<u8>` here.",
        "createdAt": "2026-01-01T00:01:00Z", "lastEditedAt": "2026-01-01T00:03:00Z", "url": "u3"
    }))
    .unwrap();

    let review = review.remark().unwrap();
    assert_eq!(
        (review.body.as_str(), review.at.as_str()),
        ("Approved", "2026-01-01T00:02:00Z")
    );
    assert!(draft.remark().is_none());
    let comment = comment.remark(Some("src/lib.rs"));
    assert_eq!(
        (
            comment.author.as_str(),
            comment.path.as_deref(),
            comment.body.as_str(),
            comment.at.as_str()
        ),
        (
            "ghost",
            Some("src/lib.rs"),
            "P1 Use `Vec<u8>` here.",
            "2026-01-01T00:03:00Z"
        )
    );
}
