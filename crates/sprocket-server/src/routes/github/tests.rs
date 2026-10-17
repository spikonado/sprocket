use super::*;

fn host_update(enabled: Option<bool>, token: Option<&str>) -> Option<HostUpdate> {
    Some(HostUpdate {
        host: "github.com".to_string(),
        enabled,
        token: token.map(str::to_string),
    })
}

#[test]
fn saves_trimmed_tokens_and_removes_them_when_empty() {
    let mut settings = GitHubSettings::default();

    apply(&mut settings, None, host_update(None, Some(" ghp_abc \n")));
    assert_eq!(
        settings.hosts["github.com"].token.as_deref(),
        Some("ghp_abc")
    );

    apply(&mut settings, None, host_update(Some(false), None));
    assert!(settings.hosts["github.com"].disabled);
    assert_eq!(
        settings.hosts["github.com"].token.as_deref(),
        Some("ghp_abc")
    );

    apply(&mut settings, Some(false), host_update(None, Some("")));
    assert!(settings.disabled);
    assert_eq!(settings.hosts["github.com"].token, None);
}
