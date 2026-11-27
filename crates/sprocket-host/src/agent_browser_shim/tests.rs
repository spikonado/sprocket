use super::*;

fn launches(args: &[&str], engine: Option<&str>, running: Option<&str>) -> bool {
    let socket_dir = tempfile::tempdir().unwrap();
    if let Some(running) = running {
        std::fs::write(socket_dir.path().join("thread.engine"), running).unwrap();
    }
    let environment = Environment {
        engine: engine.map(Into::into),
        session: Some("thread".into()),
        socket_dir: socket_dir.path().into(),
    };
    let args: Vec<OsString> = args.iter().map(Into::into).collect();
    launches_chrome(&args, &environment)
}

#[test]
fn adds_the_flag_only_where_chrome_can_launch() {
    assert!(launches(&["open", "example.com"], None, None));
    assert!(launches(&["snapshot"], None, Some("chrome")));
    assert!(launches(
        &["--engine", "chrome", "open", "a.com"],
        None,
        Some("firefox")
    ));
    assert!(launches(
        &["--session", "other", "snapshot"],
        None,
        Some("firefox")
    ));

    assert!(!launches(
        &["--engine", "firefox", "open", "a.com"],
        None,
        None
    ));
    assert!(!launches(&["open", "a.com"], Some("firefox"), None));
    assert!(!launches(&["snapshot", "-i"], None, Some("firefox\n")));
    assert!(!launches(
        &["--cdp", "ws://127.0.0.1:1/x", "tab", "new"],
        None,
        None
    ));
    assert!(!launches(&["connect", "9222"], None, None));
}
