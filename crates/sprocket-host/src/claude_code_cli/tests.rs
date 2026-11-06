use super::*;

#[test]
fn reads_the_version_claude_prints() {
    assert_eq!(
        Version::parse("2.1.318 (Claude Code)\n"),
        Some(Version(2, 1, 318))
    );
}
