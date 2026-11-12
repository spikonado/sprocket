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
        assert!(stream.read(&mut request).await.unwrap() > 0);
        let _ = stream.write_all(response.as_bytes()).await;
    });
    url
}

#[tokio::test]
async fn direct_scrapes_over_the_utf16_budget_save_markdown_until_completion() {
    let cache = tempfile::tempdir().unwrap();
    let cache_dir = cache.path().join("scrape_url");
    let fits = json!({"url": "https://example.com/page.md", "markdown": "😀".repeat(SCRAPE_INLINE_MAX_CHARS / 2)});
    let mut saved = None;
    assert_eq!(
        localize_scrape(
            fits.clone(),
            &cache_dir,
            &WorkspaceCancellation::new(),
            &mut saved
        )
        .await
        .unwrap(),
        fits
    );
    assert!(saved.is_none());

    let markdown = format!("{}x", "😀".repeat(SCRAPE_INLINE_MAX_CHARS / 2));
    let full = json!({"url": "https://example.com/page.md", "markdown": markdown});
    let result = localize_scrape(full, &cache_dir, &WorkspaceCancellation::new(), &mut saved)
        .await
        .unwrap();
    let file = saved.unwrap();
    let path = file.path().to_owned();
    assert_eq!(path.parent(), Some(cache_dir.as_path()));
    assert_eq!(path.extension().unwrap(), "md");
    assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), markdown);
    assert_eq!(
        result,
        json!({"url": "https://example.com/page.md", "savedTo": path.display().to_string()})
    );
    drop(file);
    assert!(!path.exists());
}

#[tokio::test]
async fn cancelled_direct_saves_do_not_return_a_file() {
    let cache = tempfile::tempdir().unwrap();
    let cancellation = WorkspaceCancellation::new();
    cancellation.cancel();
    let mut saved = None;
    let error = localize_scrape(
        json!({"markdown": "x".repeat(SCRAPE_INLINE_MAX_CHARS + 1)}),
        cache.path(),
        &cancellation,
        &mut saved,
    )
    .await
    .unwrap_err();
    assert!(error.is::<WorkspaceOperationCancelled>());
    assert!(saved.is_none());
}

#[tokio::test]
async fn downloaded_scrape_is_saved_while_outline_stays_in_the_output() {
    let cache = tempfile::tempdir().unwrap();
    let outline = json!({"title": "Guide", "headings": [{"level": 2, "text": "Install"}]});
    let markdown = "é\n".repeat(SCRAPE_INLINE_MAX_CHARS);
    let url = serve(&markdown, markdown.len()).await;
    let mut saved_file = None;
    let result = localize_scrape(
        json!({"url": "https://example.com", "scrapeUrl": url.as_str(), "outline": outline}),
        cache.path(),
        &WorkspaceCancellation::new(),
        &mut saved_file,
    )
    .await
    .unwrap();
    let path = saved_file.unwrap().into_temp_path();
    assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), markdown);
    assert_eq!(path.extension().unwrap(), "md");
    assert_eq!(
        result,
        json!({"url": "https://example.com", "savedTo": path.display().to_string(), "outline": outline})
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
