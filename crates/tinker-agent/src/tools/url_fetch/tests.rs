use super::super::convert::MAX_PARSE_FILE_IMAGE_BYTES;
use super::super::scrape_files::MAX_SCRAPE_BYTES;
use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
    let mut bytes = format!(
        "HTTP/1.1 {status} Test\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    bytes.extend_from_slice(body);
    bytes
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
