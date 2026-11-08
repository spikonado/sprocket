use super::*;

#[test]
fn reads_the_versions_the_clis_print() {
    assert_eq!(
        Version::parse("2.1.318 (Claude Code)\n"),
        Some(Version(2, 1, 318))
    );
    assert_eq!(
        Version::parse("Muse Code 1.4.14 (1.4.14-R7309.1)\n"),
        Some(Version(1, 4, 14))
    );
}
