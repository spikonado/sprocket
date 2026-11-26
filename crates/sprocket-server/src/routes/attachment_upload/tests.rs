use super::*;
use axum::body::{Body, Bytes};
use convex::{ConvexError, FunctionResult};
use tokio::io::AsyncReadExt;

#[test]
fn storage_limit_rejections_keep_the_plain_message() {
    let data = Value::Object(
        [
            ("code", "STORAGE_LIMIT_REACHED"),
            ("message", "File storage limit reached."),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.into()))
        .collect(),
    );
    let error = sprocket_convex::decode_labeled_function_result::<()>(
        FunctionResult::ConvexError(ConvexError {
            message: "[Request ID: 0d45611fde71c0f2] Server Error".to_string(),
            data,
        }),
        "files:createUpload",
    )
    .unwrap_err();
    let error = upload_error(error);
    assert_eq!(error.status(), StatusCode::INSUFFICIENT_STORAGE);
    assert_eq!(error.to_string(), "File storage limit reached.");
}

#[tokio::test]
async fn stages_large_binary_uploads_without_a_body_size_limit() {
    let temp = tempfile::NamedTempFile::new().unwrap();
    let chunks = futures::stream::iter(
        (0..12).map(|_| Ok::<_, std::io::Error>(Bytes::from(vec![0xff; 1024 * 1024]))),
    );
    let (size, _) = stage_body(Body::from_stream(chunks), temp.path())
        .await
        .unwrap();
    assert_eq!(size, 12 * 1024 * 1024);
    assert_eq!(tokio::fs::metadata(temp.path()).await.unwrap().len(), size);
}

#[tokio::test]
async fn staging_hashes_the_body_as_lowercase_hex() {
    let temp = tempfile::NamedTempFile::new().unwrap();
    let chunks = futures::stream::iter([
        Ok::<_, std::io::Error>(Bytes::from_static(b"a")),
        Ok(Bytes::from_static(b"bc")),
    ]);
    let (_, sha256) = stage_body(Body::from_stream(chunks), temp.path())
        .await
        .unwrap();
    assert_eq!(
        sha256,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[tokio::test]
async fn uploads_put_the_staged_file_with_the_presigned_headers() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/blob", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\ndata") {
            let mut chunk = [0; 1024];
            let read = stream.read(&mut chunk).await.unwrap();
            assert!(read > 0);
            request.extend_from_slice(&chunk[..read]);
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        String::from_utf8(request).unwrap().to_lowercase()
    });
    let temp = tempfile::NamedTempFile::new().unwrap();
    tokio::fs::write(temp.path(), b"data").await.unwrap();
    let upload = PresignedUpload {
        url,
        headers: BTreeMap::from([
            ("content-length".into(), "4".into()),
            ("x-amz-checksum-sha256".into(), "checksum".into()),
        ]),
    };
    tokio::time::timeout(Duration::from_secs(5), put_file(upload, temp.path()))
        .await
        .unwrap()
        .unwrap();
    let request = server.await.unwrap();
    assert!(request.starts_with("put /blob "));
    assert!(request.contains("\r\ncontent-length: 4\r\n"));
    assert!(request.contains("\r\nx-amz-checksum-sha256: checksum\r\n"));
}

#[tokio::test]
async fn failed_upload_stream_is_not_reported_as_complete() {
    let temp = tempfile::NamedTempFile::new().unwrap();
    let chunks = futures::stream::iter([
        Ok(Bytes::from_static(b"partial")),
        Err(std::io::Error::other("connection closed")),
    ]);
    assert!(
        stage_body(Body::from_stream(chunks), temp.path())
            .await
            .is_err()
    );
}
