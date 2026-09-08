use std::time::Duration;

use anyhow::Context;
use serde_json::Value;
use sprocket_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};
use tokio::io::AsyncWriteExt;

const MAX_SCRAPE_BYTES: u64 = 64 * 1024 * 1024;

pub(super) async fn localize_scrape(
    mut result: Value,
    cancellation: &WorkspaceCancellation,
    saved_file: &mut Option<tempfile::NamedTempFile>,
) -> anyhow::Result<Value> {
    let fields = result.as_object_mut().context("invalid scrape response")?;
    if let Some(download) = fields.remove("markdownUrl") {
        let url = reqwest::Url::parse(download.as_str().context("invalid scrape download URL")?)?;
        anyhow::ensure!(
            matches!(url.scheme(), "http" | "https"),
            "scrape download requires an http(s) URL"
        );
        let temp = tempfile::Builder::new()
            .prefix("sprocket-scrape-")
            .suffix(".md")
            .tempfile()?;
        let temp = download_scrape(url, temp, cancellation).await?;
        fields.insert(
            "markdown".into(),
            Value::String(format!(
                "The scrape was saved to {}.",
                temp.path().display()
            )),
        );
        *saved_file = Some(temp);
    } else {
        anyhow::ensure!(
            fields.get("markdown").is_some_and(Value::is_string),
            "scrape response is missing markdown"
        );
    }
    fields.remove("truncated");
    Ok(result)
}

async fn download_scrape(
    url: reqwest::Url,
    temp: tempfile::NamedTempFile,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<tempfile::NamedTempFile> {
    let transfer = async {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()?;
        let mut response = client.get(url).send().await?.error_for_status()?;
        anyhow::ensure!(
            response
                .content_length()
                .is_none_or(|size| size <= MAX_SCRAPE_BYTES),
            "scrape exceeds the 64 MiB download limit"
        );
        let mut file = tokio::fs::File::from_std(temp.reopen()?);
        let mut received = 0u64;
        while let Some(chunk) = response.chunk().await? {
            received = received.saturating_add(chunk.len() as u64);
            anyhow::ensure!(
                received <= MAX_SCRAPE_BYTES,
                "scrape exceeds the 64 MiB download limit"
            );
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        Ok::<_, anyhow::Error>(())
    };
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(WorkspaceOperationCancelled.into()),
        result = transfer => result.context("failed to save the scrape")?,
    }
    Ok(temp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::AsyncReadExt;

    async fn serve(body: &str, declared_size: usize) -> reqwest::Url {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = reqwest::Url::parse(&format!("http://{}/scrape", listener.local_addr().unwrap()))
            .unwrap();
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
    async fn short_scrapes_stay_inline_without_a_truncation_flag() {
        let result = localize_scrape(
            json!({"url": "https://example.com", "markdown": "# Hello", "truncated": false}),
            &WorkspaceCancellation::new(),
            &mut None,
        )
        .await
        .unwrap();
        assert_eq!(
            result,
            json!({"url": "https://example.com", "markdown": "# Hello"})
        );
    }

    #[tokio::test]
    async fn full_unicode_scrape_is_saved_and_only_the_notice_is_returned() {
        let text = "é\n".repeat(40_001);
        let url = serve(&text, text.len()).await;
        let mut saved_file = None;
        let result = localize_scrape(
            json!({"url": "https://example.com", "markdownUrl": url.as_str()}),
            &WorkspaceCancellation::new(),
            &mut saved_file,
        )
        .await
        .unwrap();
        let path = result["markdown"]
            .as_str()
            .unwrap()
            .strip_prefix("The scrape was saved to ")
            .unwrap()
            .strip_suffix('.')
            .unwrap();
        assert_eq!(tokio::fs::read_to_string(path).await.unwrap(), text);
        assert_eq!(
            std::path::Path::new(path).parent(),
            Some(std::env::temp_dir().as_path())
        );
        assert!(result.get("markdownUrl").is_none());
        assert!(result.get("truncated").is_none());
        tokio::fs::remove_file(path).await.unwrap();
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
}
