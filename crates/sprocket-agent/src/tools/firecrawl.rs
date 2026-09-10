use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::Context;
use convex::Value;
use futures::StreamExt;
use rig::tool::ToolExecutionError;
use serde::Deserialize;
use sprocket_workspace::WorkspaceCancellation;

use super::context::{cancelled_error, tool_error, tool_failure};
use crate::convex::RuntimeClient;

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum ResultStatus {
    Pending,
    Completed { url: String },
    Failed { error: String },
}

pub(super) async fn run(
    runtime: &RuntimeClient,
    cancellation: WorkspaceCancellation,
    mut args: BTreeMap<String, Value>,
    kind: &str,
) -> Result<serde_json::Value, ToolExecutionError> {
    if cancellation.is_cancelled() {
        return Err(cancelled_error());
    }
    let run_id = args
        .get("runId")
        .cloned()
        .context("missing run ID")
        .map_err(tool_error)?;
    args.insert("kind".into(), kind.into());
    // A lost acknowledgement can still mean the mutation committed. Never resubmit it.
    let id: String = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(cancelled_error()),
        result = tokio::time::timeout(Duration::from_secs(30), runtime.mutation_json("firecrawlRequests:start", args)) => {
            result.map_err(|_| tool_failure("Firecrawl submission timed out. Its outcome is unknown; check before repeating browser actions."))?.map_err(tool_error)?
        }
    };
    let result_args = BTreeMap::from([("id".into(), id.into()), ("runId".into(), run_id)]);
    let result = tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(cancelled_error()),
        result = tokio::time::timeout(Duration::from_secs(510), wait(runtime, result_args.clone())) => {
            result.unwrap_or_else(|_| Err(tool_failure("Firecrawl request timed out. Check the outcome before repeating browser actions.")))
        }
    };
    let _ = tokio::time::timeout(
        Duration::from_secs(5),
        runtime.mutation_json::<serde_json::Value>("firecrawlRequests:dispose", result_args),
    )
    .await;
    result
}

async fn wait(
    runtime: &RuntimeClient,
    args: BTreeMap<String, Value>,
) -> Result<serde_json::Value, ToolExecutionError> {
    let mut updates = runtime
        .subscribe("firecrawlRequests:getResult", args)
        .await
        .map_err(tool_error)?;
    while let Some(update) = updates.next().await {
        let result: ResultStatus =
            RuntimeClient::decode_subscription_update(update, "firecrawlRequests:getResult")
                .map_err(tool_error)?;
        match result {
            ResultStatus::Pending => {}
            ResultStatus::Failed { error } => return Err(tool_failure(error)),
            ResultStatus::Completed { url } => return download(&url).await.map_err(tool_error),
        }
    }
    Err(tool_failure(
        "Firecrawl result subscription closed. Check the outcome before repeating browser actions.",
    ))
}

async fn download(url: &str) -> anyhow::Result<serde_json::Value> {
    const MAX_BYTES: usize = 2_000_000;
    let mut response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()?
        .get(url)
        .send()
        .await
        .map_err(reqwest::Error::without_url)?
        .error_for_status()
        .map_err(reqwest::Error::without_url)?;
    anyhow::ensure!(
        response
            .content_length()
            .is_none_or(|size| size <= MAX_BYTES as u64),
        "Firecrawl result exceeds its size limit"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(reqwest::Error::without_url)?
    {
        anyhow::ensure!(
            chunk.len() <= MAX_BYTES.saturating_sub(bytes.len()),
            "Firecrawl result exceeds its size limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).context("Firecrawl result was not valid JSON")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn serve(status: u16, body: &str, content_length: Option<usize>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/result?secret=private-token",
            listener.local_addr().unwrap()
        );
        let length = content_length
            .map(|n| format!("Content-Length: {n}\r\n"))
            .unwrap_or_default();
        let response =
            format!("HTTP/1.1 {status} Result\r\n{length}Connection: close\r\n\r\n{body}");
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            socket.read(&mut request).await.unwrap();
            let _ = socket.write_all(response.as_bytes()).await;
        });
        url
    }

    #[tokio::test]
    async fn downloads_the_transport_without_changing_its_shape() {
        let result = json!({"mimeType": "image/png", "base64": "AA==", "byteLength": 1});
        let url = serve(200, &result.to_string(), None).await;
        assert_eq!(download(&url).await.unwrap(), result);
    }

    #[tokio::test]
    async fn bounds_both_declared_and_streamed_results() {
        for length in [Some(2_000_001), None] {
            let url = serve(200, &"x".repeat(2_000_001), length).await;
            assert!(
                download(&url)
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("size limit")
            );
        }
    }

    #[tokio::test]
    async fn rejects_invalid_results_and_redacts_storage_urls_from_http_errors() {
        let url = serve(200, "not json", None).await;
        assert!(
            download(&url)
                .await
                .unwrap_err()
                .to_string()
                .contains("not valid JSON")
        );
        let url = serve(403, "denied", Some(6)).await;
        let error = format!("{:#}", download(&url).await.unwrap_err());
        assert!(error.contains("403"));
        assert!(!error.contains("private-token"));
        assert!(!error.contains("/result"));
    }
}
