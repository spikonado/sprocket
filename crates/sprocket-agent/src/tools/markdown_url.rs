use std::time::Duration;

use reqwest::Url;
use serde_json::{Value, json};
use sprocket_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};

use super::scrape_files::MAX_SCRAPE_BYTES;

const MARKDOWN_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) async fn try_markdown_url(
    url: Url,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<Option<Value>> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(WorkspaceOperationCancelled.into()),
        result = async {
            match markdown_url(url) {
                Some(url) => fetch_markdown(url, MAX_SCRAPE_BYTES).await.ok(),
                None => None,
            }
        } => Ok(result),
    }
}

fn markdown_url(mut url: Url) -> Option<Url> {
    let path = url.path().trim_end_matches('/');
    let filename = percent_encoding::percent_decode_str(path.rsplit('/').next().unwrap_or(""))
        .decode_utf8_lossy();
    let extension = filename
        .rsplit_once('.')
        .filter(|(stem, extension)| !stem.is_empty() && !extension.is_empty())
        .map(|(_, extension)| extension);
    match extension {
        Some(extension) if extension.eq_ignore_ascii_case("md") => {}
        Some(_) => return None,
        None if filename.eq_ignore_ascii_case(".md") => {}
        None => url.set_path(&format!("{path}.md")),
    }
    url.set_fragment(None);
    Some(url)
}

async fn fetch_markdown(url: Url, max_bytes: u64) -> anyhow::Result<Value> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(MARKDOWN_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()?;
    let mut response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "text/markdown, text/plain;q=0.9")
        .send()
        .await?;
    anyhow::ensure!(
        response.status() == reqwest::StatusCode::OK,
        "no markdown endpoint"
    );
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    anyhow::ensure!(
        matches!(
            content_type.as_str(),
            "text/markdown" | "text/x-markdown" | "text/plain"
        ),
        "not a markdown response"
    );
    anyhow::ensure!(
        response
            .content_length()
            .is_none_or(|size| size <= max_bytes),
        "markdown exceeds the download limit"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        anyhow::ensure!(
            bytes.len().saturating_add(chunk.len()) as u64 <= max_bytes,
            "markdown exceeds the download limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    let markdown = String::from_utf8(bytes)?;
    let start = markdown.trim_start_matches('\u{feff}').trim_start();
    anyhow::ensure!(
        !start.is_empty() && !markdown.contains('\0'),
        "empty or binary markdown response"
    );
    anyhow::ensure!(!looks_like_html(start), "HTML fallback instead of markdown");
    Ok(json!({
        "url": response.url().as_str(),
        "markdown": markdown,
        "summary": "Summary not generated; markdown was read directly from the site.",
        "images": [],
    }))
}

fn looks_like_html(mut text: &str) -> bool {
    while let Some(comment) = text.strip_prefix("<!--") {
        let Some((_, rest)) = comment.split_once("-->") else {
            break;
        };
        text = rest.trim_start();
    }
    let Some(tag) = text.strip_prefix('<') else {
        return false;
    };
    if tag.starts_with(['!', '?']) {
        return true;
    }
    let tag = tag.strip_prefix('/').unwrap_or(tag);
    if !tag.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return false;
    }
    let after_name = tag.trim_start_matches(|c: char| c.is_ascii_alphanumeric() || c == '-');
    after_name.starts_with(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/')
}

#[cfg(test)]
mod tests {
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
            let url =
                Url::parse(&format!("http://{}{path}", listener.local_addr().unwrap())).unwrap();
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
            let (url, server) = serve(vec![bytes]).await;
            assert!(try_markdown_url(url, &WorkspaceCancellation::new()).await.unwrap().is_none());
            server.await.unwrap();
        }
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
}
