use super::*;

#[test]
fn parses_host_owner_and_name() {
    assert_eq!(
        parse_repository("github.com/acme/.github"),
        Some(Repository {
            host: "github.com",
            owner: "acme",
            name: ".github"
        })
    );
    assert!(parse_repository("ghe.example.com/acme/widgets").is_some());
}

#[test]
fn ignores_local_projects_and_unsafe_paths() {
    for key in [
        "widgets",
        "directory:/home/me/widgets",
        "github.com/acme",
        "github.com/acme/widgets/extra",
        "github.com/acme/..",
        "github.com/acme/widgets?x=1",
    ] {
        assert!(parse_repository(key).is_none(), "{key}");
    }
}

#[test]
fn batches_lookups_as_aliases_with_typed_variables() {
    let refs = [
        PullRequestRef {
            repository: "github.com/acme/widgets".into(),
            number: 7,
        },
        PullRequestRef {
            repository: "github.com/acme/gears".into(),
            number: 12,
        },
    ];
    let batch: Vec<_> = refs
        .iter()
        .map(|pr| (pr, parse_repository(&pr.repository).unwrap()))
        .collect();

    let (query, variables) = batch_query(&batch);

    assert_eq!(
        query,
        "query PullRequestStates($o0: String!, $n0: String!, $p0: Int!, $o1: String!, $n1: String!, $p1: Int!) { \
         pr0: repository(owner: $o0, name: $n0) { pullRequest(number: $p0) { state title } } \
         pr1: repository(owner: $o1, name: $n1) { pullRequest(number: $p1) { state title } } }"
    );
    assert_eq!(
        variables,
        serde_json::json!({"o0": "acme", "n0": "widgets", "p0": 7, "o1": "acme", "n1": "gears", "p1": 12})
    );
}

#[test]
fn failing_hosts_pause_longer_each_time_until_they_answer() {
    let pauses = HostPauses::default();
    let start = Instant::now();
    let paused_at = |minutes: u64| {
        pauses.is_paused(
            "user",
            "github.com",
            start + Duration::from_secs(minutes * 60),
        )
    };

    pauses.record("user", "github.com", Some(&GitHubError::RateLimited), start);
    assert!(paused_at(1));
    assert!(!paused_at(2));
    assert!(!pauses.is_paused("other-user", "github.com", start));

    pauses.record("user", "github.com", Some(&GitHubError::RateLimited), start);
    assert!(paused_at(3));
    assert!(!paused_at(4));

    for _ in 0..10 {
        pauses.record("user", "github.com", Some(&GitHubError::RateLimited), start);
    }
    assert!(paused_at(29));
    assert!(!paused_at(30));

    pauses.record("user", "github.com", None, start);
    assert!(!paused_at(0));
}

#[test]
fn missing_credentials_do_not_pause_a_host() {
    let pauses = HostPauses::default();
    let now = Instant::now();

    pauses.record(
        "user",
        "github.com",
        Some(&GitHubError::NoCredential("github.com".into())),
        now,
    );

    assert!(!pauses.is_paused("user", "github.com", now));
}
