use super::*;

#[test]
fn adapts_dashboard_assets_and_dynamic_stream_paths() {
    let source = r#"<script src="/_next/static/app.js"></script>fetch("/api/sessions");let path=`/api/session/${port}/stream`;"#;
    assert_eq!(
        rewrite_asset(source),
        r#"<script src="/api/browser/dashboard/_next/static/app.js"></script>fetch("/api/browser/dashboard/api/sessions");let path=`/api/browser/dashboard/api/session/${port}/stream`;"#
    );
    assert_eq!(
        upstream_path("/api/browser/dashboard/api/session/123/stream?maxFps=10").unwrap(),
        "/api/session/123/stream?maxFps=10"
    );
    assert_eq!(
        upstream_path("/api/browser/dashboard/api/sessions?name=a%20b").unwrap(),
        "/api/sessions?name=a%20b"
    );
}

#[test]
fn dashboard_cannot_select_another_upstream() {
    for path in [
        "/api/browser/dashboard//example.com",
        "/api/browser/dashboard/../auth",
        "/api/browser/dashboard/%2f%2fexample.com",
        "/api/auth",
    ] {
        assert!(upstream_path(path).is_err());
    }
}

#[test]
fn dashboard_offers_only_chrome_without_chat() {
    let source = r#"let o=[{id:"chrome",label:"Chrome",engine:"chrome"},{id:"lightpanda",label:"Lightpanda",engine:"lightpanda"},{id:"agentcore",label:"AgentCore",provider:"agentcore"},{id:"browserbase",label:"Browserbase",provider:"browserbase"},{id:"browserless",label:"Browserless",provider:"browserless"},{id:"browser-use",label:"Browser Use",provider:"browser-use"},{id:"kernel",label:"Kernel",provider:"kernel"}];(0,ex.jsxs)(Iz,{defaultValue:"chat",children:[(0,ex.jsx)(IP,{value:"chat",className:"text-[11px]",children:"Chat"})]})"#;
    assert_eq!(
        rewrite_asset(source),
        r#"let o=[{id:"chrome",label:"Chrome",engine:"chrome"}];(0,ex.jsxs)(Iz,{defaultValue:"activity",children:[(0,ex.jsx)(IP,{value:"chat",className:"hidden",children:"Chat"})]})"#
    );
}
