use super::*;

#[test]
fn helper_success_requires_a_version_and_successful_exit() {
    let previous = PackageUpdateSnapshot::unavailable();
    for (json, exit_ok) in [
        (
            r#"{"status":"installed","currentVersion":"1.0.0","version":"1.1.0"}"#,
            false,
        ),
        (r#"{"status":"installed","currentVersion":"1.0.0"}"#, true),
        (r#"{"status":"available","currentVersion":"1.0.0"}"#, true),
    ] {
        let snapshot = parse_helper_output(json.as_bytes(), b"", exit_ok, &previous);
        assert_eq!(snapshot.status, UpdateStatus::Error);
        assert!(snapshot.error.is_some());
    }
}

#[test]
fn helper_json_maps_known_statuses() {
    let previous = PackageUpdateSnapshot::unavailable();
    let snapshot = parse_helper_output(
        br#"{"status":"idle","currentVersion":"1.0.0","version":null,"error":null,"method":"package"}"#,
        b"",
        true,
        &previous,
    );
    assert_eq!(snapshot.status, UpdateStatus::Idle);
    let snapshot = parse_helper_output(
        br#"{"status":"available","currentVersion":"1.0.0","version":"1.1.0","error":null,"method":"package"}"#,
        b"",
        true,
        &previous,
    );
    assert_eq!(snapshot.status, UpdateStatus::Available);
    let snapshot = parse_helper_output(
        br#"{"status":"installed","currentVersion":"1.1.0","version":"1.1.0","error":null,"method":"package"}"#,
        b"",
        true,
        &previous,
    );
    assert_eq!(snapshot.status, UpdateStatus::Installed);
    let snapshot = parse_helper_output(
        br#"{"status":"downloading","currentVersion":"1.0.0","version":"1.1.0","error":null,"method":"package"}"#,
        b"",
        true,
        &previous,
    );
    assert_eq!(snapshot.status, UpdateStatus::Error);
    assert_eq!(snapshot.version.as_deref(), Some("1.1.0"));
}

#[test]
fn helper_parse_error_keeps_previous_version() {
    let previous = PackageUpdateSnapshot {
        status: UpdateStatus::Available,
        current_version: "1.0.0".to_string(),
        version: Some("1.1.0".to_string()),
        error: None,
        method: UpdateMethod::Package,
        message: None,
        restart_launcher: None,
    };
    let snapshot = parse_helper_output(b"not-json", b"boom", false, &previous);
    assert_eq!(snapshot.status, UpdateStatus::Error);
    assert_eq!(snapshot.current_version, "1.0.0");
    assert_eq!(snapshot.version.as_deref(), Some("1.1.0"));
}
