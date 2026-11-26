use super::*;
use tokio::io::AsyncWriteExt;

async fn respond(status: &str, body: &str) -> reqwest::Response {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        assert!(socket.read(&mut request).await.unwrap() > 0);
        let _ = socket.write_all(response.as_bytes()).await;
    });
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .post(url)
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn failed_requests_surface_the_action_message() {
    let response = respond("502 Bad Gateway", "context.dev credits are exhausted.\n").await;
    let error = success_body(response, 1024).await.unwrap_err();
    assert_eq!(error.to_string(), "context.dev credits are exhausted.");

    let response = respond("200 OK", "{}").await;
    assert_eq!(success_body(response, 1024).await.unwrap(), b"{}");
}

#[test]
fn scrape_outputs_report_page_errors_from_successful_responses() {
    let response: ScrapeResponse = serde_json::from_str(
        r#"{"url":"https://example.com","markdown":{"success":false,"error_code":"NOT_FOUND","message":"Page missing "},"bytes":null}"#,
    )
    .unwrap();
    assert_eq!(
        response
            .markdown
            .unwrap()
            .require()
            .unwrap_err()
            .to_string(),
        "This webpage returned an error: Page missing (NOT_FOUND)"
    );

    let response: ScrapeResponse = serde_json::from_str(
        r#"{"url":"https://example.com/a.pdf","markdown":null,"bytes":{"success":true,"data":{"base64":"AA==","contentType":"application/pdf"}}}"#,
    )
    .unwrap();
    let data = response.bytes.unwrap().require().unwrap().unwrap();
    assert_eq!(data.content_type.as_deref(), Some("application/pdf"));
}

#[test]
fn truncated_parses_are_rejected() {
    let parsed = br#"{"success":true,"data":{"markdown":"page 1","metadata":{"numPages":1,"totalPages":3}}}"#;
    assert_eq!(
        decode_parsed(parsed).err().unwrap().to_string(),
        "Parsed document was truncated."
    );
    let complete = br#"{"success":true,"data":{"markdown":"page 1","metadata":{"numPages":1,"totalPages":1}}}"#;
    assert_eq!(
        decode_parsed(complete).unwrap().markdown.as_deref(),
        Some("page 1")
    );
}
