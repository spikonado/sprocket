use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn serve(responses: Vec<Vec<u8>>) -> (Url, tokio::task::JoinHandle<Vec<String>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!(
        "http://{}/docs/start?lang=en#intro",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        for response in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            let count = stream.read(&mut bytes).await.unwrap();
            requests.push(String::from_utf8_lossy(&bytes[..count]).into_owned());
            let _ = stream.write_all(&response).await;
        }
        requests
    });
    (url, task)
}

fn response(status: u16, mime: &str, body: &[u8]) -> Vec<u8> {
    let mut bytes = format!("HTTP/1.1 {status} Test\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

#[test]
fn html_detection_preserves_markdown_containing_code_examples() {
    assert!(!looks_like_html("<https://example.com>"));
    assert!(!looks_like_html("<user@example.com>"));
    assert!(!looks_like_html(
        "# HTML example\n```html\n<html><body>Hello</body></html>\n```"
    ));
    assert!(!looks_like_html(
        "<!-- docs -->\n# Title\nAn example of <html>."
    ));
    assert!(looks_like_html(
        "<!-- fallback -->\n<!DOCTYPE HTML><html>Not found</html>"
    ));
}

#[test]
fn candidate_changes_only_the_path_and_fragment() {
    for (source, expected) in [
        (
            "https://eve.dev/docs/getting-started",
            "https://eve.dev/docs/getting-started.md",
        ),
        (
            "https://example.com/docs/?q=a%26b#heading",
            "https://example.com/docs.md?q=a%26b",
        ),
        (
            "https://example.com/a%2Fb%20c",
            "https://example.com/a%2Fb%20c.md",
        ),
        (
            "https://example.com/README.MD?raw=true",
            "https://example.com/README.MD?raw=true",
        ),
        (
            "https://example.com/docs.v2/start?file=guide.pdf#intro",
            "https://example.com/docs.v2/start.md?file=guide.pdf",
        ),
        (
            "https://example.com/guide%2Emd",
            "https://example.com/guide%2Emd",
        ),
        ("https://example.com/.md", "https://example.com/.md"),
        (
            "https://example.com/.well-known/guide",
            "https://example.com/.well-known/guide.md",
        ),
        ("https://example.com/", "https://example.com/.md"),
    ] {
        assert_eq!(
            markdown_url(Url::parse(source).unwrap()).unwrap().as_str(),
            expected
        );
    }
}

#[test]
fn documentation_roots_also_probe_index_markdown() {
    for (source, expected) in [
        (
            "https://developers.cloudflare.com/tunnel/",
            [
                "https://developers.cloudflare.com/tunnel.md",
                "https://developers.cloudflare.com/tunnel/index.md",
            ],
        ),
        (
            "https://developers.cloudflare.com/tunnel",
            [
                "https://developers.cloudflare.com/tunnel.md",
                "https://developers.cloudflare.com/tunnel/index.md",
            ],
        ),
        (
            "https://example.com/docs/?q=a%26b#heading",
            [
                "https://example.com/docs.md?q=a%26b",
                "https://example.com/docs/index.md?q=a%26b",
            ],
        ),
        (
            "https://example.com/",
            ["https://example.com/.md", "https://example.com/index.md"],
        ),
    ] {
        assert_eq!(
            markdown_urls(Url::parse(source).unwrap())
                .iter()
                .map(Url::as_str)
                .collect::<Vec<_>>(),
            expected
        );
    }
    assert_eq!(
        markdown_urls(Url::parse("https://example.com/README.MD?raw=true").unwrap())
            .iter()
            .map(Url::as_str)
            .collect::<Vec<_>>(),
        ["https://example.com/README.MD?raw=true"]
    );
}

#[tokio::test]
async fn file_extensions_skip_the_probe_without_a_request() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    for path in [
        "/guide.html",
        "/guide.PDF?download=1#page=2",
        "/archive.tar.gz",
        "/photo.png",
        "/download.custom",
        "/guide%2Ehtml",
        "/guide.html/",
        "/.config.json",
    ] {
        let url = Url::parse(&format!("http://{}{path}", listener.local_addr().unwrap())).unwrap();
        assert!(markdown_url(url.clone()).is_none(), "{path}");
        assert!(
            try_markdown_url(url, &WorkspaceCancellation::new())
                .await
                .unwrap()
                .is_none(),
            "{path}"
        );
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn existing_markdown_url_is_read_without_appending() {
    let (mut url, server) = serve(vec![response(200, "text/markdown", b"# Direct")]).await;
    url.set_path("/guide.md");
    let result = try_markdown_url(url, &WorkspaceCancellation::new())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result["markdown"], "# Direct");
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("GET /guide.md?lang=en HTTP/1.1"));
}

#[tokio::test]
async fn direct_markdown_is_read_with_a_single_get() {
    for mime in [
        "text/markdown; charset=utf-8",
        "text/plain",
        "text/x-markdown",
    ] {
        let (url, server) = serve(vec![response(200, mime, "# Héllo\n".as_bytes())]).await;
        let result = try_markdown_url(url, &WorkspaceCancellation::new())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["markdown"], "# Héllo\n");
        assert!(
            result["url"]
                .as_str()
                .unwrap()
                .ends_with("/docs/start.md?lang=en")
        );
        assert_eq!(result["images"], json!([]));
        assert!(
            result["summary"]
                .as_str()
                .unwrap()
                .contains("not generated")
        );
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET /docs/start.md?lang=en HTTP/1.1"));
        assert!(!requests[0].to_lowercase().contains("authorization:"));
        assert!(!requests[0].to_lowercase().contains("cookie:"));
    }
}

#[tokio::test]
async fn unusable_responses_allow_firecrawl_fallback() {
    for bytes in [
        response(404, "text/plain", b"Not found"),
        response(403, "text/plain", b"Forbidden"),
        response(500, "text/plain", b"Unavailable"),
        response(206, "text/markdown", b"# Partial"),
        response(200, "text/html", b"<p>Login</p>"),
        response(200, "text/plain", b"<title>Not found</title>"),
        response(200, "text/plain", b"<meta charset=utf-8>"),
        response(200, "text/markdown", b"<script>location.href='/login'</script>"),
        response(200, "text/markdown", b"<div class=error>Not found</div>"),
        response(200, "text/markdown", b"<p>Not found</p>"),
        response(200, "text/plain", b" \n<!-- fallback -->\n<!DOCTYPE HTML><html>Not found</html>"),
        response(200, "application/json", b"{}"),
        response(200, "text/markdown", &[0xff, 0xfe]),
        response(200, "text/markdown", b"# Title\0binary"),
        response(200, "text/markdown", b" \n"),
        b"HTTP/1.1 200 OK\r\nContent-Type: text/markdown\r\nContent-Length: 100\r\nConnection: close\r\n\r\npartial".to_vec(),
    ] {
        let (url, server) = serve(vec![bytes.clone(), bytes]).await;
        assert!(try_markdown_url(url, &WorkspaceCancellation::new()).await.unwrap().is_none());
        server.await.unwrap();
    }
}

#[tokio::test]
async fn index_markdown_is_used_when_the_suffixed_path_is_missing() {
    let (mut url, server) = serve(vec![
        response(404, "text/plain", b"Not found"),
        response(200, "text/markdown", b"# Tunnel"),
    ])
    .await;
    url.set_path("/tunnel/");
    let result = try_markdown_url(url, &WorkspaceCancellation::new())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result["markdown"], "# Tunnel");
    assert!(
        result["url"]
            .as_str()
            .unwrap()
            .ends_with("/tunnel/index.md?lang=en")
    );
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].starts_with("GET /tunnel.md?lang=en HTTP/1.1"));
    assert!(requests[1].starts_with("GET /tunnel/index.md?lang=en HTTP/1.1"));
}

#[tokio::test]
async fn redirects_are_followed_without_appending_again() {
    let (url, server) = serve(vec![
        b"HTTP/1.1 302 Found\r\nLocation: /canonical.md\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        response(200, "text/markdown", b"# Canonical"),
    ]).await;
    let result = try_markdown_url(url, &WorkspaceCancellation::new())
        .await
        .unwrap()
        .unwrap();
    assert!(result["url"].as_str().unwrap().ends_with("/canonical.md"));
    let requests = server.await.unwrap();
    assert!(requests[1].starts_with("GET /canonical.md HTTP/1.1"));
}

#[tokio::test]
async fn byte_limit_applies_with_or_without_content_length() {
    for bytes in [
        response(200, "text/markdown", b"123456789"),
        b"HTTP/1.1 200 OK\r\nContent-Type: text/markdown\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n9\r\n123456789\r\n0\r\n\r\n".to_vec(),
    ] {
        let (url, server) = serve(vec![bytes]).await;
        let error = fetch_markdown(url, 8).await.unwrap_err();
        assert!(error.to_string().contains("download limit"));
        server.await.unwrap();
    }
}

#[tokio::test]
async fn cancellation_does_not_trigger_fallback() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}/slow", listener.local_addr().unwrap())).unwrap();
    let cancellation = WorkspaceCancellation::new();
    let cancel = cancellation.clone();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        stream.read(&mut request).await.unwrap();
        cancel.cancel();
        let mut eof = [0];
        assert_eq!(stream.read(&mut eof).await.unwrap(), 0);
    });
    let error = try_markdown_url(url, &cancellation).await.unwrap_err();
    assert!(error.is::<WorkspaceOperationCancelled>());
    server.await.unwrap();
}
