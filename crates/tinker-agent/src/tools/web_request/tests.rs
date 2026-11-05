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
    let response = format!("HTTP/1.1 {status} Result\r\n{length}Connection: close\r\n\r\n{body}");
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
