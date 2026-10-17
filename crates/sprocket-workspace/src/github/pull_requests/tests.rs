use super::*;

fn github_or(enterprise: &'static str) -> impl Fn(&str) -> bool {
    move |host| host == "github.com" || host == enterprise
}

#[test]
fn parses_github_keys_and_the_configured_enterprise_host() {
    assert_eq!(
        parse_repository("github.com/acme/.github", github_or("ghe.example.com")),
        Some(Repository {
            host: "github.com",
            owner: "acme",
            name: ".github"
        })
    );
    assert!(
        parse_repository("ghe.example.com/acme/widgets", github_or("ghe.example.com")).is_some()
    );
}

#[test]
fn ignores_other_forges_local_projects_and_unsafe_paths() {
    for key in [
        "gitlab.com/acme/widgets",
        "widgets",
        "directory:/home/me/widgets",
        "github.com/acme",
        "github.com/acme/widgets/extra",
        "github.com/acme/..",
        "github.com/acme/widgets?x=1",
    ] {
        assert!(
            parse_repository(key, github_or("ghe.example.com")).is_none(),
            "{key}"
        );
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
        .map(|pr| (pr, parse_repository(&pr.repository, github_or("")).unwrap()))
        .collect();

    let (query, variables) = batch_query(&batch);

    assert_eq!(
        query,
        "query PullRequestStates($o0: String!, $n0: String!, $p0: Int!, $o1: String!, $n1: String!, $p1: Int!) { \
         pr0: repository(owner: $o0, name: $n0) { pullRequest(number: $p0) { state } } \
         pr1: repository(owner: $o1, name: $n1) { pullRequest(number: $p1) { state } } }"
    );
    assert_eq!(
        variables,
        serde_json::json!({"o0": "acme", "n0": "widgets", "p0": 7, "o1": "acme", "n1": "gears", "p1": 12})
    );
}
