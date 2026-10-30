use super::*;

#[test]
fn points_the_editor_at_the_proxy() {
    let html = r#"window.TSCIRCUIT_FILESERVER_API_BASE_URL = "http://127.0.0.1:3081/api";<script src="https://cdn.tailwindcss.com"></script><script type="module" src="/standalone.min.js"></script>"#;
    assert_eq!(
        rewrite_html(html, "/api/tscircuit/dev/ab12/", 3081),
        r#"window.TSCIRCUIT_FILESERVER_API_BASE_URL = "/api/tscircuit/dev/ab12/api";<script src="https://cdn.tailwindcss.com"></script><script type="module" src="/api/tscircuit/dev/ab12/standalone.min.js"></script>"#
    );
    assert_eq!(
        rewrite_script(
            r#"fetch("/api/extra_runframe_tabs/list")"#,
            "/api/tscircuit/dev/ab12/"
        ),
        r#"fetch("/api/tscircuit/dev/ab12/api/extra_runframe_tabs/list")"#
    );
    assert_eq!(
        upstream_path("/api/tscircuit/dev/ab12/api/files/get?file_path=src%2Fa.tsx").unwrap(),
        ("ab12".into(), "/api/files/get?file_path=src%2Fa.tsx".into())
    );
}

#[test]
fn editor_cannot_select_another_upstream() {
    for path in [
        "/api/tscircuit/dev/ab12//example.com",
        "/api/tscircuit/dev/ab12/../auth",
        "/api/tscircuit/dev/ab12/%2e%2e/auth",
        "/api/tscircuit/dev/../ab12/",
        "/api/tscircuit/dev/ab12",
    ] {
        assert!(upstream_path(path).is_err(), "{path}");
    }
}
