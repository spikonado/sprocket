use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn serve(content_type: &str, bytes: Vec<u8>) -> reqwest::Url {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    );
    tokio::spawn(async move {
        for _ in 0..2 {
            let Ok(Ok((mut stream, _))) =
                tokio::time::timeout(Duration::from_secs(2), listener.accept()).await
            else {
                break;
            };
            let mut request = [0; 4096];
            stream.read(&mut request).await.unwrap();
            stream.write_all(header.as_bytes()).await.unwrap();
            if !request.starts_with(b"HEAD ") {
                let _ = stream.write_all(&bytes).await;
            }
        }
    });
    reqwest::Url::parse(&format!("http://{address}/without-extension")).unwrap()
}

fn png() -> Vec<u8> {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(1, 1)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

#[tokio::test]
async fn screenshot_saves_pixels_locally_for_history() {
    let cache = tempfile::tempdir().unwrap();
    let store = crate::transcript::TranscriptStore::new(cache.path().join("transcripts"));
    let directory = store.thread_dir("user", "thread").join("screenshot_url");
    let mut download = serve("application/octet-stream", png()).await;
    download.set_query(Some("signature=temporary-secret"));
    let metadata = fetch_screenshot(
        json!({
            "url": "https://example.com/page", "screenshotUrl": download.as_str(),
        }),
        &directory,
    )
    .await
    .unwrap();
    assert_eq!(metadata["url"], "https://example.com/page");
    assert_eq!(metadata["mediaType"], "image/png");
    assert_eq!(metadata["width"], 1);
    assert!(!metadata.to_string().contains("temporary-secret"));
    assert_image_history("screenshot_url", metadata, &directory).await;
    assert!(!directory.with_file_name("parse_file").exists());
}

#[tokio::test]
async fn screenshot_rejects_missing_fields_and_non_http_downloads() {
    let cache = tempfile::tempdir().unwrap();
    for result in [
        json!({"url": "https://example.com"}),
        json!({"url": "https://example.com", "screenshotUrl": "file:///tmp/image.png"}),
        json!({"url": "file:///tmp/page.html", "screenshotUrl": "https://example.com/image.png"}),
    ] {
        assert!(fetch_screenshot(result, cache.path()).await.is_err());
    }
}

#[tokio::test]
async fn screenshot_rejects_non_images_and_oversized_dimensions() {
    let cache = tempfile::tempdir().unwrap();
    let mut oversized = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(8193, 1)
        .write_to(&mut oversized, image::ImageFormat::Png)
        .unwrap();
    for bytes in [
        b"<html>not a screenshot</html>".to_vec(),
        oversized.into_inner(),
    ] {
        let download = serve("image/png", bytes).await;
        assert!(
            fetch_screenshot(
                json!({
                    "url": "https://example.com", "screenshotUrl": download.as_str(),
                }),
                cache.path()
            )
            .await
            .is_err()
        );
    }
}

#[tokio::test]
async fn image_without_extension_is_saved_locally_and_validated_by_signature() {
    let cache = tempfile::tempdir().unwrap();
    let directory = cache.path().join("scrape_url");
    let url = serve("image/jpeg", png()).await;
    let metadata = fetch_web_image(url, true, &directory)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(metadata["mediaType"], "image/png");
    assert_image_history("scrape_url", metadata, &directory).await;
}

async fn assert_image_history(name: &str, mut metadata: serde_json::Value, cache: &Path) {
    use crate::types::{
        AgentHistoryContent, AgentHistoryMessage, AgentHistoryRole, AgentHistoryToolResultItem,
    };
    use base64::Engine;

    let path = Path::new(metadata["path"].as_str().unwrap());
    assert_eq!(path.parent().unwrap(), cache.canonicalize().unwrap());
    assert_eq!(tokio::fs::read(path).await.unwrap(), png());
    assert!(!metadata.to_string().contains("iVBORw0KGgo"));
    let output = replay_image_tool_output(&metadata).await.unwrap();
    let saved_path = format!("Image saved to: {}", path.display());
    let expected = rig::message::ToolResultContent::image_base64(
        base64::engine::general_purpose::STANDARD.encode(png()),
        Some(rig::message::ImageMediaType::PNG),
        None,
    );
    assert_eq!(
        serde_json::to_value(output.into_content()).unwrap(),
        json!([
            rig::message::ToolResultContent::text(saved_path.clone()),
            expected
        ])
    );

    metadata["url"] = json!("http://127.0.0.1:1/unavailable");
    let part = serde_json::from_value(json!({
        "number": 1, "sourceKey": "tool:inv-1:finished", "kind": "tool", "runId": "run",
        "tool": {"toolInvocationId": "inv-1", "callId": "call", "name": name, "status": "completed", "output": metadata}
    }))
    .unwrap();
    let mut history = vec![AgentHistoryMessage {
        role: AgentHistoryRole::User,
        origin: None,
        contents: vec![AgentHistoryContent::ToolResult {
            id: "call".into(),
            call_id: Some("call".into()),
            items: vec![AgentHistoryToolResultItem::Text {
                text: metadata.to_string(),
            }],
        }],
    }];
    super::super::hydrate_tool_history(&mut history, std::slice::from_ref(&part), true).await;
    let AgentHistoryContent::ToolResult { items, .. } = &history[0].contents[0] else {
        panic!("missing result")
    };
    let [
        AgentHistoryToolResultItem::Text { text },
        AgentHistoryToolResultItem::Image { image_json },
    ] = items.as_slice()
    else {
        panic!("missing saved path and image")
    };
    assert_eq!(text, &saved_path);
    let rig::message::ToolResultContent::Image(expected) = expected else {
        unreachable!()
    };
    assert_eq!(image_json, &serde_json::to_string(&expected).unwrap());

    super::super::hydrate_tool_history(&mut history, std::slice::from_ref(&part), false).await;
    let serialized = serde_json::to_string(&history).unwrap();
    assert!(serialized.contains("Image omitted"));
    assert!(!serialized.contains("imageJson"));

    tokio::fs::remove_file(metadata["path"].as_str().unwrap())
        .await
        .unwrap();
    super::super::hydrate_tool_history(&mut history, &[part], true).await;
    let serialized = serde_json::to_string(&history).unwrap();
    assert!(serialized.contains("not available in the local cache"));
    assert!(!serialized.contains("imageJson"));
}

#[tokio::test]
async fn image_download_fails_when_local_persistence_fails() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let url = serve("image/png", png()).await;
    assert!(fetch_web_image(url, true, file.path()).await.is_err());
}

#[tokio::test]
async fn html_is_left_to_the_scraper() {
    let cache = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url =
        reqwest::Url::parse(&format!("http://{}/page", listener.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        stream.read(&mut request).await.unwrap();
        assert!(request.starts_with(b"HEAD "));
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 50\r\nConnection: close\r\n\r\n").await.unwrap();
        listener
    });
    assert!(
        fetch_web_image(url, true, cache.path())
            .await
            .unwrap()
            .is_none()
    );
    let listener = server.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn image_extension_handles_generic_content_types() {
    let cache = tempfile::tempdir().unwrap();
    let mut url = serve("application/octet-stream", png()).await;
    url.set_path("/image.PNG");
    assert!(
        fetch_web_image(url, true, cache.path())
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn unrecognized_content_is_scraped_but_text_only_models_reject_images() {
    let cache = tempfile::tempdir().unwrap();
    let url = serve("image/svg+xml", b"<svg></svg>".to_vec()).await;
    assert!(
        fetch_web_image(url, true, cache.path())
            .await
            .unwrap()
            .is_none()
    );
    let url = serve("image/jpeg", b"<html>mislabelled</html>".to_vec()).await;
    assert!(fetch_web_image(url, true, cache.path()).await.is_err());
    let url = serve("image/png", png()).await;
    assert!(
        fetch_web_image(url, false, cache.path())
            .await
            .unwrap_err()
            .to_string()
            .contains("cannot view")
    );
}

#[test]
fn urls_must_be_http() {
    for url in [
        "file:///tmp/file",
        "data:image/png;base64,abc",
        "ftp://example.com",
    ] {
        assert!(validate_web_url(url).is_err());
    }
}

#[tokio::test]
async fn screenshot_download_reads_extensionless_images_without_head() {
    let cache = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url =
        reqwest::Url::parse(&format!("http://{}/opaque", listener.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        stream.read(&mut request).await.unwrap();
        assert!(request.starts_with(b"GET "));
        let bytes = png();
        let headers = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        );
        stream.write_all(headers.as_bytes()).await.unwrap();
        stream.write_all(&bytes).await.unwrap();
    });
    let metadata = fetch_screenshot(
        json!({
            "url": "https://example.com/page", "screenshotUrl": url.as_str(),
        }),
        cache.path(),
    )
    .await
    .unwrap();
    server.await.unwrap();
    assert_eq!(metadata["mediaType"], "image/png");
}
