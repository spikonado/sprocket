use std::io::{Read, Write};

use super::*;

#[test]
fn server_discovery_never_sends_pairing_material_off_machine() {
    for url in [
        "http://127.0.0.1:17731",
        "http://localhost:7731",
        "http://[::1]:17731",
    ] {
        assert!(validate_local_url(url).is_ok());
    }
    for url in [
        "https://example.com",
        "http://127.0.0.1.evil.test",
        "http://user@localhost",
        "http://localhost/api",
        "http://localhost?x=1",
    ] {
        assert!(validate_local_url(url).is_err());
    }
}

#[tokio::test]
async fn legacy_bootstrap_rejection_includes_restart_guidance() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 4096];
        let _ = stream.read(&mut request).unwrap();
        let body = r#"{"error":"authentication required"}"#;
        write!(
            stream,
            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len(),
        )
        .unwrap();
    });
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let error = post::<CliBootstrapResponse>(&http, &address, "", "bootstrap", &())
        .await
        .err()
        .unwrap();
    server.join().unwrap();
    assert_eq!(
        error.downcast_ref::<HttpError>().unwrap().status,
        reqwest::StatusCode::UNAUTHORIZED
    );
    let message = error.to_string();
    assert!(message.contains("authentication required"), "{message}");
    assert!(
        message.contains("restart the running app or server"),
        "{message}"
    );
    assert!(message.contains("PUBLIC_CONVEX_URL"), "{message}");
    assert!(!transient(&error));
}

#[tokio::test]
async fn stale_published_service_does_not_block_configured_address() {
    let stale_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let stale_address = format!("http://{}", stale_listener.local_addr().unwrap());
    let stale_server = std::thread::spawn(move || {
        let (mut stream, _) = stale_listener.accept().unwrap();
        let mut request = [0; 1024];
        let _ = stream.read(&mut request).unwrap();
        stream
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
            .unwrap();
    });
    let unused_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let unused_port = unused_listener.local_addr().unwrap().port();
    drop(unused_listener);
    let data_dir = std::env::temp_dir().join(format!(
        "sprocket-cli-discovery-test-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&data_dir).unwrap();
    std::fs::write(
        data_dir.join("server-address.json"),
        serde_json::json!({ "url": stale_address }).to_string(),
    )
    .unwrap();
    let config = ServerConfig {
        host: "127.0.0.1".into(),
        port: unused_port,
        data_dir: Some(data_dir.clone()),
        static_dir: None,
        api_only: true,
        convex_deployment_url: None,
    };
    let http = reqwest::Client::builder().no_proxy().build().unwrap();

    assert!(discover(&http, &config).await.unwrap().is_none());

    stale_server.join().unwrap();
    std::fs::remove_dir_all(data_dir).unwrap();
}
