use super::*;

fn graphql_errors(json: &str) -> Vec<GraphQlError> {
    serde_json::from_str(json).unwrap()
}

#[test]
fn graphql_url_maps_hosts_and_rejects_argument_like_hosts() {
    assert_eq!(
        graphql_url("github.com").unwrap().as_str(),
        "https://api.github.com/graphql"
    );
    assert_eq!(
        graphql_url("acme.ghe.com").unwrap().as_str(),
        "https://api.acme.ghe.com/graphql"
    );
    assert_eq!(
        graphql_url("ghe.example.com").unwrap().as_str(),
        "https://ghe.example.com/api/graphql"
    );
    for host in ["", "--help", "a/b", "host:8080", ".example.com"] {
        assert!(graphql_url(host).is_err(), "{host:?} should be rejected");
    }
}

#[test]
fn rate_limits_are_read_from_status_headers_and_graphql_errors() {
    let limited = graphql_errors(r#"[{"type":"RATE_LIMITED","message":"slow down"}]"#);
    let not_found = graphql_errors(r#"[{"type":"NOT_FOUND","message":"no such PR"}]"#);
    let ok = StatusCode::OK;
    assert!(is_rate_limited(
        StatusCode::TOO_MANY_REQUESTS,
        None,
        false,
        None,
        ""
    ));
    assert!(is_rate_limited(ok, None, false, Some(&limited), ""));
    assert!(is_rate_limited(ok, Some("0"), false, Some(&not_found), ""));
    assert!(is_rate_limited(StatusCode::FORBIDDEN, None, true, None, ""));
    assert!(is_rate_limited(
        StatusCode::FORBIDDEN,
        None,
        false,
        None,
        "You have exceeded a secondary rate limit"
    ));
    assert!(!is_rate_limited(
        ok,
        Some("12"),
        false,
        Some(&not_found),
        ""
    ));
    assert!(!is_rate_limited(
        StatusCode::FORBIDDEN,
        Some("12"),
        false,
        None,
        "SSO required"
    ));
}

#[test]
fn rate_limit_waits_follow_retry_after_then_the_quota_reset() {
    let now = UNIX_EPOCH + Duration::from_secs(1_000);

    assert_eq!(
        retry_after(Some("30"), Some("0"), Some("2000"), now),
        Some(Duration::from_secs(30))
    );
    assert_eq!(
        retry_after(None, Some("0"), Some("1600"), now),
        Some(Duration::from_secs(600))
    );
    assert_eq!(retry_after(None, Some("12"), Some("1600"), now), None);
    assert_eq!(retry_after(None, Some("0"), Some("900"), now), None);
    assert_eq!(retry_after(None, None, None, now), None);
}
