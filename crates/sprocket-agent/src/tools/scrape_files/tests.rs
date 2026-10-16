use super::*;
use serde_json::json;
use tokio::io::AsyncReadExt;

async fn serve(body: &str, declared_size: usize) -> reqwest::Url {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url =
        reqwest::Url::parse(&format!("http://{}/scrape", listener.local_addr().unwrap())).unwrap();
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {declared_size}\r\nConnection: close\r\n\r\n{body}"
    );
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        stream.read(&mut request).await.unwrap();
        let _ = stream.write_all(response.as_bytes()).await;
    });
    url
}

#[tokio::test]
async fn short_scrapes_preserve_outline_and_images_without_a_truncation_flag() {
    let result = localize_scrape(
        json!({"url": "https://example.com", "markdown": "# Hello", "outline": {"title": "Hello", "headings": []}, "images": ["https://example.com/image.png"], "truncated": false}),
        &WorkspaceCancellation::new(),
        &mut None,
    )
    .await
    .unwrap();
    assert_eq!(
        result,
        json!({"url": "https://example.com", "markdown": "# Hello", "outline": {"title": "Hello", "headings": []}, "images": ["https://example.com/image.png"]})
    );
}

#[tokio::test]
async fn direct_scrapes_use_utf16_budget_and_keep_full_json_until_completion() {
    let short = json!({"url": "https://example.com/page.md", "markdown": "# Short", "images": []});
    let mut saved = None;
    assert_eq!(
        localize_scrape(short.clone(), &WorkspaceCancellation::new(), &mut saved)
            .await
            .unwrap(),
        short
    );
    assert!(saved.is_none());

    let mut full = short;
    full["markdown"] = json!("😀".repeat(20_000));
    assert!(full.to_string().chars().count() < SCRAPE_INLINE_MAX_CHARS);
    let result = localize_scrape(full.clone(), &WorkspaceCancellation::new(), &mut saved)
        .await
        .unwrap();
    let file = saved.unwrap();
    let path = file.path().to_owned();
    assert_eq!(path.extension().unwrap(), "json");
    assert_eq!(
        serde_json::from_str::<Value>(&tokio::fs::read_to_string(&path).await.unwrap()).unwrap(),
        full
    );
    assert_eq!(result["url"], full["url"]);
    assert_eq!(
        result["markdown"],
        format!(
            "The scrape was too large to directly output. Instead, it has been saved to {} for you to view.",
            path.display()
        )
    );
    drop(file);
    assert!(!path.exists());
}

#[tokio::test]
async fn cancelled_direct_saves_do_not_return_a_file() {
    let cancellation = WorkspaceCancellation::new();
    cancellation.cancel();
    let mut saved = None;
    let error = localize_scrape(
        json!({"markdown": "x".repeat(40_001)}),
        &cancellation,
        &mut saved,
    )
    .await
    .unwrap_err();
    assert!(error.is::<WorkspaceOperationCancelled>());
    assert!(saved.is_none());
}

#[tokio::test]
async fn full_scrape_is_saved_while_outline_and_highlights_stay_in_the_output() {
    let outline = json!({"title": "Guide", "headings": [{"level": 2, "text": "Install"}]});
    let scrape = json!({"markdown": "é\n".repeat(40_001), "outline": outline, "images": ["https://example.com/image.png"]});
    let text = scrape.to_string();
    let url = serve(&text, text.len()).await;
    let mut saved_file = None;
    let result = localize_scrape(
        json!({"url": "https://example.com", "scrapeUrl": url.as_str(), "outline": outline, "highlights": ["Run the installer."]}),
        &WorkspaceCancellation::new(),
        &mut saved_file,
    )
    .await
    .unwrap();
    let path = result["markdown"]
        .as_str()
        .unwrap()
        .strip_prefix("The scrape was too large to directly output. Instead, it has been saved to ")
        .unwrap()
        .strip_suffix(" for you to view.")
        .unwrap();
    assert_eq!(tokio::fs::read_to_string(path).await.unwrap(), text);
    assert_eq!(result["outline"], outline);
    assert_eq!(result["highlights"], json!(["Run the installer."]));
    assert_eq!(std::path::Path::new(path).extension().unwrap(), "json");
    assert_eq!(
        std::path::Path::new(path).parent(),
        Some(std::env::temp_dir().as_path())
    );
    assert!(result.get("scrapeUrl").is_none());
    assert!(result.get("truncated").is_none());
    tokio::fs::remove_file(path).await.unwrap();
}

#[tokio::test]
async fn json_results_over_the_inline_limit_are_saved_to_a_file() {
    let small = json!({"results": [{"url": "https://example.com", "passages": []}]});
    let mut saved = None;
    assert_eq!(
        localize_json(
            small.clone(),
            "test-",
            &WorkspaceCancellation::new(),
            &mut saved
        )
        .await
        .unwrap(),
        small
    );
    assert!(saved.is_none());

    let large = json!({"results": [{"url": "https://example.com", "passages": [{"text": "x".repeat(40_000)}]}]});
    let result = localize_json(
        large.clone(),
        "test-",
        &WorkspaceCancellation::new(),
        &mut saved,
    )
    .await
    .unwrap();
    let file = saved.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&tokio::fs::read_to_string(file.path()).await.unwrap())
            .unwrap(),
        large
    );
    assert_eq!(
        result,
        json!({"message": format!(
            "The result was too large to directly output. Instead, it has been saved to {} for you to view.",
            file.path().display()
        )})
    );
}

#[tokio::test]
async fn successful_download_is_removed_unless_completion_is_accepted() {
    let url = serve("scrape", 6).await;
    let temp = tempfile::NamedTempFile::new().unwrap();
    let path = temp.path().to_path_buf();
    let file = download_scrape(url, temp, &WorkspaceCancellation::new())
        .await
        .unwrap();
    assert!(path.exists());
    drop(file);
    assert!(!path.exists());
}

#[tokio::test]
async fn oversized_or_incomplete_transfers_remove_partial_files() {
    for declared_size in [MAX_SCRAPE_BYTES as usize + 1, 100] {
        let url = serve("partial", declared_size).await;
        let temp = tempfile::NamedTempFile::new().unwrap();
        let path = temp.path().to_path_buf();
        assert!(
            download_scrape(url, temp, &WorkspaceCancellation::new())
                .await
                .is_err()
        );
        assert!(!path.exists());
    }
}

#[tokio::test]
async fn cancelled_transfers_remove_temporary_files() {
    let temp = tempfile::NamedTempFile::new().unwrap();
    let path = temp.path().to_path_buf();
    let cancellation = WorkspaceCancellation::new();
    cancellation.cancel();
    let error = download_scrape(
        reqwest::Url::parse("http://127.0.0.1:1").unwrap(),
        temp,
        &cancellation,
    )
    .await
    .unwrap_err();
    assert!(error.is::<WorkspaceOperationCancelled>());
    assert!(!path.exists());
}
