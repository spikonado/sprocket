use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const HEAD_REJECTED: &str =
    "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

fn headers(content_type: &str, content_length: usize) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\n"
    )
}

async fn serve(content_type: &str, bytes: Vec<u8>) -> reqwest::Url {
    let headers = headers(content_type, bytes.len());
    serve_split(headers.clone(), headers, bytes).await
}

/// Answers HEAD with `head`, and GET with `get` followed by `body`.
async fn serve_split(head: String, get: String, body: Vec<u8>) -> reqwest::Url {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        for _ in 0..2 {
            let Ok(Ok((mut stream, _))) =
                tokio::time::timeout(Duration::from_secs(2), listener.accept()).await
            else {
                break;
            };
            let mut request = [0; 4096];
            stream.read(&mut request).await.unwrap();
            if request.starts_with(b"HEAD ") {
                stream.write_all(head.as_bytes()).await.unwrap();
            } else {
                let _ = stream.write_all(get.as_bytes()).await;
                let _ = stream.write_all(&body).await;
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

async fn fetch_image(url: reqwest::Url, cache: &Path) -> serde_json::Value {
    let LocalResource::Image(metadata) = fetch_local_resource(url, true, cache).await.unwrap()
    else {
        panic!("expected an image");
    };
    metadata
}

async fn is_page(url: reqwest::Url, cache: &Path) -> bool {
    matches!(
        fetch_local_resource(url, true, cache).await.unwrap(),
        LocalResource::Page
    )
}

async fn is_unreadable_document(url: reqwest::Url, cache: &Path) -> bool {
    matches!(
        fetch_local_resource(url, true, cache).await.unwrap(),
        LocalResource::UnreadableDocument
    )
}

async fn fetch_document(url: reqwest::Url, cache: &Path) -> WebDocument {
    let LocalResource::Document(document) = fetch_local_resource(url, true, cache).await.unwrap()
    else {
        panic!("expected a document");
    };
    document
}

fn pdf() -> Vec<u8> {
    b"%PDF-1.4\n%placeholder\n".to_vec()
}

#[tokio::test]
async fn historical_screenshots_replay_from_the_local_cache() {
    let cache = tempfile::tempdir().unwrap();
    let store = sprocket_transcript::TranscriptStore::new(cache.path().join("transcripts"));
    let directory = store.thread_dir("user", "thread").join("screenshot_url");
    let url = reqwest::Url::parse("https://example.com/page").unwrap();
    let metadata = persist_web_image(png(), &url, &directory).await.unwrap();
    assert_image_history("screenshot_url", metadata, &directory).await;
}

#[tokio::test]
async fn image_without_extension_is_saved_locally_and_validated_by_signature() {
    let cache = tempfile::tempdir().unwrap();
    let directory = cache.path().join("scrape_url");
    let url = serve("image/jpeg", png()).await;
    let metadata = fetch_image(url, &directory).await;
    assert_eq!(metadata["mediaType"], "image/png");
    assert_image_history("scrape_url", metadata, &directory).await;
}

async fn assert_image_history(name: &str, mut metadata: serde_json::Value, cache: &Path) {
    use super::super::image_urls::ImageUrlMap;
    use crate::types::{
        AgentHistoryContent, AgentHistoryMessage, AgentHistoryRole, AgentHistoryToolResultItem,
    };
    use base64::Engine;

    let path = Path::new(metadata["path"].as_str().unwrap());
    assert_eq!(path.parent().unwrap(), cache.canonicalize().unwrap());
    assert_eq!(tokio::fs::read(path).await.unwrap(), png());
    assert!(!metadata.to_string().contains("iVBORw0KGgo"));
    let output = replay_tool_output(&metadata, None).await.unwrap();
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
    super::super::hydrate_tool_history(&mut history, std::slice::from_ref(&part), true, None).await;
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

    let url = "https://example.convex.cloud/api/storage/image";
    let stored = ImageUrlMap::from([(
        hex::encode(<sha2::Sha256 as sha2::Digest>::digest(png())),
        url.to_string(),
    )]);
    let items = super::super::convert::replay_local_tool_output(&metadata)
        .await
        .unwrap()
        .into_history_items(&stored)
        .unwrap();
    let rig::message::ToolResultContent::Image(by_url) = rig::message::ToolResultContent::image_url(
        url,
        Some(rig::message::ImageMediaType::PNG),
        None,
    ) else {
        unreachable!()
    };
    assert!(matches!(
        &items[1],
        AgentHistoryToolResultItem::Image { image_json }
            if image_json == &serde_json::to_string(&by_url).unwrap()
    ));

    super::super::hydrate_tool_history(&mut history, std::slice::from_ref(&part), false, None)
        .await;
    let serialized = serde_json::to_string(&history).unwrap();
    assert!(serialized.contains("Image omitted"));
    assert!(!serialized.contains("imageJson"));

    tokio::fs::remove_file(metadata["path"].as_str().unwrap())
        .await
        .unwrap();
    super::super::hydrate_tool_history(&mut history, &[part], true, None).await;
    let serialized = serde_json::to_string(&history).unwrap();
    assert!(serialized.contains("not available in the local cache"));
    assert!(!serialized.contains("imageJson"));
}

#[tokio::test]
async fn image_download_fails_when_local_persistence_fails() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let url = serve("image/png", png()).await;
    assert!(fetch_local_resource(url, true, file.path()).await.is_err());
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
    assert!(is_page(url, cache.path()).await);
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
    fetch_image(url, cache.path()).await;
}

#[tokio::test]
async fn unrecognized_content_is_scraped_but_text_only_models_reject_images() {
    let cache = tempfile::tempdir().unwrap();
    let url = serve("image/svg+xml", b"<svg></svg>".to_vec()).await;
    assert!(is_page(url, cache.path()).await);
    let url = serve("image/jpeg", b"<html>mislabelled</html>".to_vec()).await;
    assert!(fetch_local_resource(url, true, cache.path()).await.is_err());
    let url = serve("image/png", png()).await;
    assert!(
        fetch_local_resource(url, false, cache.path())
            .await
            .unwrap_err()
            .to_string()
            .contains("cannot view")
    );
}

#[tokio::test]
async fn documents_are_downloaded_for_local_parsing() {
    let cache = tempfile::tempdir().unwrap();
    for content_type in ["application/pdf", "application/octet-stream"] {
        let url = serve(content_type, pdf()).await;
        assert_eq!(fetch_document(url, cache.path()).await.bytes, pdf());
    }
}

#[tokio::test]
async fn expected_documents_served_as_other_content_are_left_for_a_raw_fetch() {
    let cache = tempfile::tempdir().unwrap();
    let challenge = b"<html>checking your browser</html>".to_vec();
    for content_type in ["application/pdf", "application/octet-stream"] {
        let url = serve_split(
            headers(content_type, 0),
            headers("text/html", challenge.len()),
            challenge.clone(),
        )
        .await;
        assert!(is_unreadable_document(url, cache.path()).await);
    }
    let get = headers("text/html", challenge.len());
    let mut url = serve_split(HEAD_REJECTED.into(), get, challenge).await;
    url.set_path("/datasheet.pdf");
    assert!(is_unreadable_document(url, cache.path()).await);
    let url = serve("text/csv", vec![0xFF, 0, 0xFE]).await;
    assert!(is_unreadable_document(url, cache.path()).await);
}

#[tokio::test]
async fn inconclusive_head_responses_leave_detection_to_the_get() {
    let cache = tempfile::tempdir().unwrap();
    let get = headers("application/pdf", pdf().len());
    let url = serve_split(HEAD_REJECTED.into(), get.clone(), pdf()).await;
    assert_eq!(fetch_document(url, cache.path()).await.bytes, pdf());

    let mut url = serve_split(headers("text/plain", pdf().len()), get, pdf()).await;
    url.set_path("/datasheet.pdf");
    assert_eq!(fetch_document(url, cache.path()).await.bytes, pdf());

    let html = b"<html>a page</html>".to_vec();
    let url = serve_split(HEAD_REJECTED.into(), headers("text/html", html.len()), html).await;
    assert!(is_page(url, cache.path()).await);
}

#[tokio::test]
async fn csv_is_parsed_locally() {
    let cache = tempfile::tempdir().unwrap();
    let csv = b"part,stock\nresistor,12\n".to_vec();
    let mut by_extension = serve("application/octet-stream", csv.clone()).await;
    by_extension.set_path("/stock.csv");
    for url in [
        serve("text/csv; charset=utf-8", csv.clone()).await,
        by_extension,
    ] {
        let document = fetch_document(url, cache.path()).await;
        assert_eq!(document.hint, Some(anydoc::Format::Csv));
        let (markdown, format) = convert_document(
            document.bytes,
            super::super::github_url::url_file_name(&document.url),
            document.hint,
            None,
            &WorkspaceCancellation::new(),
        )
        .await
        .unwrap();
        assert_eq!(format, "csv");
        assert!(
            markdown.contains("resistor") && markdown.contains('|'),
            "{markdown}"
        );
    }
}

#[tokio::test]
async fn oversized_documents_are_rejected_instead_of_scraped() {
    let cache = tempfile::tempdir().unwrap();
    let mut body = pdf();
    body.resize(DOCUMENT_SNIFF_BYTES * 2, b' ');
    let get = headers("application/pdf", MAX_SCRAPE_BYTES as usize + 1);
    let url = serve_split(HEAD_REJECTED.into(), get, body).await;
    let error = fetch_local_resource(url, true, cache.path())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("64 MiB"), "{error}");
}

#[tokio::test]
async fn truncated_documents_are_left_for_a_raw_fetch() {
    let cache = tempfile::tempdir().unwrap();
    let get = headers("application/pdf", DOCUMENT_SNIFF_BYTES);
    let url = serve_split(HEAD_REJECTED.into(), get.clone(), pdf()).await;
    assert!(is_unreadable_document(url, cache.path()).await);
    let url = serve_split(HEAD_REJECTED.into(), get, b"%P".to_vec()).await;
    assert!(is_unreadable_document(url, cache.path()).await);
}

#[tokio::test]
async fn unreachable_document_urls_are_left_for_a_raw_fetch() {
    let cache = tempfile::tempdir().unwrap();
    for path in ["datasheet.pdf", "table.csv"] {
        let url = reqwest::Url::parse(&format!("http://127.0.0.1:1/{path}")).unwrap();
        assert!(is_unreadable_document(url, cache.path()).await);
    }
    let url = reqwest::Url::parse("http://127.0.0.1:1/page").unwrap();
    assert!(is_page(url, cache.path()).await);
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
