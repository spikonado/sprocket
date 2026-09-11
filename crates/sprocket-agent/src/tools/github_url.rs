use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use reqwest::Url;
use serde_json::{Value, json};
use sprocket_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};

use super::parse_file::{
    IMAGE_SNIFF_BYTES, MAX_PARSE_FILE_IMAGE_BYTES, convert_file_bytes, sniff_supported_image_format,
};
use super::scrape_files::MAX_SCRAPE_BYTES;

pub(super) fn github_raw_url(url: &Url) -> Option<Url> {
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let mut raw = match url.host_str()? {
        "raw.githubusercontent.com" => url.clone(),
        "github.com" | "www.github.com" if url.port().is_none() => {
            let segments: Vec<_> = url.path_segments()?.collect();
            if segments.len() < 5
                || segments.iter().any(|segment| segment.is_empty())
                || !matches!(segments[2], "blob" | "raw" | "blame")
            {
                return None;
            }
            let mut raw = Url::parse("https://raw.githubusercontent.com").ok()?;
            raw.set_path(&format!(
                "/{}/{}/{}",
                segments[0],
                segments[1],
                segments[3..].join("/")
            ));
            raw.set_query(url.query());
            raw
        }
        _ => return None,
    };
    raw.set_fragment(None);
    Some(raw)
}

pub(super) async fn fetch_github_file(
    url: Url,
    supports_images: bool,
    cache_dir: &Path,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<Value> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(WorkspaceOperationCancelled.into()),
        result = async {
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::limited(5))
                .build()?;
            let (url, bytes) = download_file(&client, url, MAX_SCRAPE_BYTES).await?;
            if sniff_supported_image_format(&bytes).is_some() {
                anyhow::ensure!(supports_images, "The selected model cannot view images.");
                return super::web::persist_web_image(&bytes, &url, cache_dir).await;
            }
            let filename = url.path_segments().and_then(Iterator::last).unwrap_or("");
            let path = PathBuf::from(percent_encoding::percent_decode_str(filename).decode_utf8_lossy().as_ref());
            let (markdown, _) = tokio::task::spawn_blocking(move || convert_file_bytes(bytes, &path))
                .await.context("GitHub file parser failed")??;
            Ok(json!({
                "url": url.as_str(),
                "markdown": markdown,
                "summary": "Summary not generated; file was read directly from GitHub.",
                "images": [],
            }))
        } => result.context("failed to read GitHub file locally"),
    }
}

async fn download_file(
    client: &reqwest::Client,
    url: Url,
    mut max_bytes: u64,
) -> anyhow::Result<(Url, Vec<u8>)> {
    let mut response = client.get(url).send().await?.error_for_status()?;
    anyhow::ensure!(
        response.status() == reqwest::StatusCode::OK,
        "expected a complete GitHub file response"
    );
    let content_length = response.content_length();
    anyhow::ensure!(
        content_length.is_none_or(|size| size <= max_bytes),
        "GitHub file exceeds the download limit"
    );
    let mut bytes = Vec::new();
    let mut prefix = Vec::with_capacity(IMAGE_SNIFF_BYTES);
    while let Some(chunk) = response.chunk().await? {
        let prefix_bytes = chunk.len().min(IMAGE_SNIFF_BYTES - prefix.len());
        prefix.extend_from_slice(&chunk[..prefix_bytes]);
        if sniff_supported_image_format(&prefix).is_some() {
            max_bytes = max_bytes.min(MAX_PARSE_FILE_IMAGE_BYTES as u64);
        }
        anyhow::ensure!(
            content_length.is_none_or(|size| size <= max_bytes),
            "GitHub file exceeds the download limit"
        );
        anyhow::ensure!(
            bytes.len().saturating_add(chunk.len()) as u64 <= max_bytes,
            "GitHub file exceeds the download limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok((response.url().clone(), bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn maps_file_views_without_changing_refs_or_encoded_paths() {
        for (source, expected) in [
            (
                "https://github.com/owner/repo/blob/main/src/lib.rs#L10-L20",
                "https://raw.githubusercontent.com/owner/repo/main/src/lib.rs",
            ),
            (
                "http://www.github.com/owner/repo/blob/abc123/LICENSE",
                "https://raw.githubusercontent.com/owner/repo/abc123/LICENSE",
            ),
            (
                "https://github.com/owner/repo/blob/feature/docs/guide%20one%23two.md?plain=1#heading",
                "https://raw.githubusercontent.com/owner/repo/feature/docs/guide%20one%23two.md?plain=1",
            ),
            (
                "https://github.com/owner/repo/blob/feature%2Fdocs/.github/config%2Eyml",
                "https://raw.githubusercontent.com/owner/repo/feature%2Fdocs/.github/config%2Eyml",
            ),
            (
                "https://github.com/owner/repo/raw/refs/heads/main/data.csv",
                "https://raw.githubusercontent.com/owner/repo/refs/heads/main/data.csv",
            ),
            (
                "https://github.com/owner/repo/blame/v1.0/src/main.rs",
                "https://raw.githubusercontent.com/owner/repo/v1.0/src/main.rs",
            ),
            (
                "https://raw.githubusercontent.com/owner/repo/main/README.md?token=example#L1",
                "https://raw.githubusercontent.com/owner/repo/main/README.md?token=example",
            ),
        ] {
            assert_eq!(
                github_raw_url(&Url::parse(source).unwrap())
                    .unwrap()
                    .as_str(),
                expected,
                "{source}"
            );
        }
    }

    #[test]
    fn leaves_non_file_pages_and_other_hosts_on_the_existing_route() {
        for source in [
            "https://github.com/owner/repo",
            "https://github.com/owner/repo/tree/main/src",
            "https://github.com/owner/repo/issues/123",
            "https://github.com/owner/repo/blob/main",
            "https://github.com/owner/repo/blob/main/",
            "https://github.com/owner//blob/main/file.rs",
            "https://github.com.example.com/owner/repo/blob/main/file.rs",
            "https://example.com/owner/repo/blob/main/file.rs",
            "https://github.com@evil.example/owner/repo/blob/main/file.rs",
            "https://github.com:8443/owner/repo/blob/main/file.rs",
            "ftp://github.com/owner/repo/blob/main/file.rs",
        ] {
            assert!(
                github_raw_url(&Url::parse(source).unwrap()).is_none(),
                "{source}"
            );
        }
        assert!(
            github_raw_url(&Url::parse("https://raw.githubusercontent.com/missing").unwrap())
                .is_some()
        );
    }

    async fn serve(responses: Vec<Vec<u8>>) -> (Url, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/source", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let count = stream.read(&mut request).await.unwrap();
                requests.push(String::from_utf8_lossy(&request[..count]).into_owned());
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

    #[tokio::test]
    async fn reads_source_verbatim_with_one_get_and_no_markdown_probe() {
        let cache = tempfile::tempdir().unwrap();
        for (path, mime, body) in [
            ("/src/lib.rs", "text/plain", "fn main() {}\n"),
            ("/LICENSE", "application/octet-stream", "Copyright é\n"),
            (
                "/index.html",
                "text/plain",
                "<!doctype html><html>Hello</html>",
            ),
            (
                "/README.md",
                "text/plain",
                "<!-- docs -->\n<div>Hello</div>",
            ),
            ("/data.json", "application/json", "{\"hello\": true}"),
        ] {
            let (mut url, server) = serve(vec![response(200, mime, body.as_bytes())]).await;
            url.set_path(path);
            let result = fetch_github_file(
                url.clone(),
                false,
                cache.path(),
                &WorkspaceCancellation::new(),
            )
            .await
            .unwrap();
            assert_eq!(result["url"], url.as_str());
            assert_eq!(result["markdown"], body);
            assert_eq!(result["images"], json!([]));
            let requests = server.await.unwrap();
            assert_eq!(requests.len(), 1);
            assert!(requests[0].starts_with(&format!("GET {path} HTTP/1.1")));
            assert!(!requests[0].to_lowercase().contains("authorization:"));
            assert!(!requests[0].to_lowercase().contains("cookie:"));
        }
        assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn converts_documents_locally_after_redirects() {
        let cache = tempfile::tempdir().unwrap();
        let (url, server) = serve(vec![
            b"HTTP/1.1 302 Found\r\nLocation: /table%2Ecsv\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
            response(200, "text/plain", b"name,value\nsprocket,42\n"),
        ]).await;
        let result = fetch_github_file(url, false, cache.path(), &WorkspaceCancellation::new())
            .await
            .unwrap();
        assert!(result["url"].as_str().unwrap().ends_with("/table%2Ecsv"));
        assert!(
            result["markdown"]
                .as_str()
                .unwrap()
                .contains("| sprocket | 42 |")
        );
        assert_eq!(server.await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn errors_are_returned_instead_of_allowing_hosted_fallback() {
        let cache = tempfile::tempdir().unwrap();
        for bytes in [
            response(404, "text/plain", b"Not Found"),
            response(403, "text/plain", b"Forbidden"),
            response(429, "text/plain", b"Rate limited"),
            response(500, "text/plain", b"Unavailable"),
            response(206, "text/plain", b"Partial"),
            response(200, "application/octet-stream", &[0xff, 0xfe]),
            response(200, "text/plain", b"binary\0content"),
            response(200, "text/plain", b""),
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\npartial".to_vec(),
        ] {
            let (url, server) = serve(vec![bytes]).await;
            assert!(
                fetch_github_file(url, false, cache.path(), &WorkspaceCancellation::new())
                    .await
                    .is_err()
            );
            assert_eq!(server.await.unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn image_bytes_use_the_existing_model_and_cache_limits() {
        let cache = tempfile::tempdir().unwrap();
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(1, 1)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        for supports_images in [true, false] {
            let (url, server) = serve(vec![response(
                200,
                "application/octet-stream",
                png.get_ref(),
            )])
            .await;
            let result = fetch_github_file(
                url,
                supports_images,
                cache.path(),
                &WorkspaceCancellation::new(),
            )
            .await;
            if supports_images {
                let result = result.unwrap();
                assert_eq!(result["outputType"], "image");
                assert_eq!(result["mediaType"], "image/png");
                assert_eq!(
                    tokio::fs::read(result["path"].as_str().unwrap())
                        .await
                        .unwrap(),
                    *png.get_ref()
                );
                super::super::parse_file::replay_image_tool_output(&result)
                    .await
                    .unwrap();
            } else {
                assert!(format!("{:#}", result.unwrap_err()).contains("cannot view images"));
            }
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn download_limit_applies_with_or_without_content_length() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for bytes in [
            response(200, "text/plain", b"123456789"),
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n9\r\n123456789\r\n0\r\n\r\n".to_vec(),
        ] {
            let (url, server) = serve(vec![bytes]).await;
            let error = download_file(&client, url, 8).await.unwrap_err();
            assert!(error.to_string().contains("download limit"));
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn image_limit_applies_during_download_even_without_an_image_content_type() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let signature = b"\x89PNG\r\n\x1a\n";
        let declared = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            MAX_PARSE_FILE_IMAGE_BYTES + 1
        );
        let mut oversized = declared.into_bytes();
        oversized.extend_from_slice(signature);

        let mut chunked = b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
        for byte in signature {
            chunked.extend_from_slice(&[b'1', b'\r', b'\n', *byte, b'\r', b'\n']);
        }
        chunked.extend_from_slice(format!("{MAX_PARSE_FILE_IMAGE_BYTES:x}\r\n").as_bytes());
        chunked.resize(chunked.len() + MAX_PARSE_FILE_IMAGE_BYTES, 0);
        chunked.extend_from_slice(b"\r\n0\r\n\r\n");

        for response in [oversized, chunked] {
            let (url, server) = serve(vec![response]).await;
            let error = download_file(&client, url, MAX_SCRAPE_BYTES)
                .await
                .unwrap_err();
            assert!(error.to_string().contains("download limit"), "{error:#}");
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn cancellation_aborts_the_request() {
        let cache = tempfile::tempdir().unwrap();
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
        let error = fetch_github_file(url, false, cache.path(), &cancellation)
            .await
            .unwrap_err();
        assert!(error.is::<WorkspaceOperationCancelled>());
        server.await.unwrap();
    }
}
