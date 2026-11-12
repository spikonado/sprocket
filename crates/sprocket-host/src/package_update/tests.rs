use super::*;

#[test]
fn missing_or_relative_env_disables_updates() {
    let root = std::env::current_dir().unwrap();
    let node = root.join("node").display().to_string();
    let script = root.join("update-api.js").display().to_string();
    assert!(parse_update_command(None, None).is_none());
    assert!(parse_update_command(Some(&node), None).is_none());
    assert!(parse_update_command(Some(""), Some(&script)).is_none());
    assert!(parse_update_command(Some("node"), Some(&script)).is_none());
    assert!(parse_update_command(Some(&node), Some("update-api.js")).is_none());
    assert!(parse_update_command(Some(&node), Some(&script)).is_some());
    assert!(
        parse_update_command(Some(&format!("  {node}  ")), Some(&format!("  {script}  ")))
            .is_some()
    );
}
