use super::*;

fn check(name: &str, outcome: CheckOutcome) -> Check {
    Check {
        name: name.into(),
        outcome,
        url: None,
    }
}

fn remark(id: &str, at: &str) -> Remark {
    Remark {
        id: id.into(),
        author: "reviewer".into(),
        path: None,
        body: "Looks off".into(),
        at: at.into(),
        url: format!("https://github.com/acme/widgets/pull/7#{id}"),
    }
}

fn activity(head_sha: &str, checks: Vec<Check>, remarks: Vec<Remark>) -> Activity {
    Activity {
        state: PullRequestState::Open,
        head_sha: head_sha.into(),
        conflicting: Some(false),
        checks,
        remarks,
    }
}

#[test]
fn first_look_reports_check_results_but_not_old_comments() {
    let now = activity(
        "a1",
        vec![
            check("rust", CheckOutcome::Failed),
            check("web", CheckOutcome::Passed),
        ],
        vec![remark("old", "2026-01-01T00:00:00Z")],
    );

    let report = compare(&Seen::first_look(&now), &now);

    assert_eq!(
        report.changes,
        [Change::ChecksFailed, Change::ChecksFinished]
    );
    assert!(report.new_remarks.is_empty());
    assert!(compare(&report.next, &now).changes.is_empty());
}

#[test]
fn reports_each_failure_and_finish_once_per_head() {
    let pending = activity("a1", vec![check("rust", CheckOutcome::Pending)], vec![]);
    let seen = compare(&Seen::first_look(&pending), &pending).next;
    let failed = activity("a1", vec![check("rust", CheckOutcome::Failed)], vec![]);
    let seen = compare(&seen, &failed).next;
    assert!(compare(&seen, &failed).changes.is_empty());

    let pushed = activity("b2", vec![check("rust", CheckOutcome::Pending)], vec![]);
    let seen = compare(&seen, &pushed).next;
    let failed_again = activity("b2", vec![check("rust", CheckOutcome::Failed)], vec![]);
    assert_eq!(
        compare(&seen, &failed_again).changes,
        [Change::ChecksFailed, Change::ChecksFinished]
    );
}

#[test]
fn reports_comments_after_the_cursor_including_ones_in_the_same_second() {
    let first = activity("a1", vec![], vec![remark("one", "2026-01-01T00:00:00Z")]);
    let seen = Seen::first_look(&first);
    let later = activity(
        "a1",
        vec![],
        vec![
            remark("one", "2026-01-01T00:00:00Z"),
            remark("two", "2026-01-01T00:00:00Z"),
            remark("three", "2026-01-01T00:05:00Z"),
        ],
    );

    let report = compare(&seen, &later);

    assert_eq!(report.changes, [Change::NewComments]);
    let ids: Vec<_> = report.new_remarks.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["two", "three"]);
    assert!(compare(&report.next, &later).changes.is_empty());
}

#[test]
fn reports_conflicts_and_merges() {
    let open = activity("a1", vec![], vec![]);
    let seen = Seen::first_look(&open);
    let conflicting = Activity {
        conflicting: Some(true),
        ..open.clone()
    };
    let seen = compare(&seen, &conflicting).next;
    let still_computing = Activity {
        conflicting: None,
        ..open.clone()
    };
    assert!(compare(&seen, &still_computing).changes.is_empty());

    let merged = Activity {
        state: PullRequestState::Merged,
        ..open
    };
    assert_eq!(compare(&seen, &merged).changes, [Change::Merged]);
}

#[test]
fn reads_checks_and_others_remarks_from_graphql() {
    let data: Data = serde_json::from_value(serde_json::json!({
        "viewer": { "login": "Me" },
        "repository": { "pullRequest": {
            "state": "OPEN",
            "mergeable": "UNKNOWN",
            "headRefOid": "a1",
            "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "contexts": { "nodes": [
                { "__typename": "CheckRun", "name": "rust", "status": "COMPLETED", "conclusion": "TIMED_OUT", "detailsUrl": "https://ci/rust" },
                { "__typename": "CheckRun", "name": "docs", "status": "COMPLETED", "conclusion": "SKIPPED", "detailsUrl": null },
                { "__typename": "StatusContext", "context": "deploy", "state": "PENDING", "targetUrl": null }
            ] } } } }] },
            "comments": { "nodes": [
                { "id": "c1", "author": { "login": "me" }, "body": "My own note", "createdAt": "2026-01-01T00:00:00Z", "lastEditedAt": null, "url": "u1" }
            ] },
            "reviews": { "nodes": [
                { "id": "r1", "author": { "login": "review-bot" }, "state": "APPROVED", "body": "<!-- meta -->", "submittedAt": "2026-01-01T00:02:00Z", "url": "u2", "comments": { "nodes": [] } },
                { "id": "r2", "author": null, "state": "COMMENTED", "body": "", "submittedAt": "2026-01-01T00:01:00Z", "url": "u3", "comments": { "nodes": [
                    { "id": "rc1", "path": "src/lib.rs", "body": "<a href=\"#\"><img alt=\"P1\" src=\"x.svg\"></a> Use `Vec<u8>` here.", "url": "u4" }
                ] } },
                { "id": "r3", "author": { "login": "draft" }, "state": "PENDING", "body": "Draft", "submittedAt": null, "url": "u5", "comments": { "nodes": [] } }
            ] }
        } }
    }))
    .unwrap();

    let activity = data
        .repository
        .unwrap()
        .pull_request
        .unwrap()
        .activity(&data.viewer.login);

    let outcomes: Vec<_> = activity.checks.iter().map(|c| c.outcome).collect();
    assert_eq!(
        outcomes,
        [
            CheckOutcome::Failed,
            CheckOutcome::Passed,
            CheckOutcome::Pending
        ]
    );
    assert_eq!(activity.conflicting, None);
    let remarks: Vec<_> = activity
        .remarks
        .iter()
        .map(|r| (r.author.as_str(), r.path.as_deref(), r.body.as_str()))
        .collect();
    assert_eq!(
        remarks,
        [
            ("ghost", Some("src/lib.rs"), "P1 Use `Vec<u8>` here."),
            ("review-bot", None, "Approved"),
        ]
    );
}
