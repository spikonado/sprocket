use super::*;

#[test]
fn the_users_claude_settings_stay_out() {
    for key in [
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_USE_BEDROCK",
        "claude_config_dir",
        "MCP_TOOL_TIMEOUT",
    ] {
        assert!(is_inherited_claude_setting(OsStr::new(key)), "{key}");
    }
    assert!(!is_inherited_claude_setting(OsStr::new("PATH")));
}
