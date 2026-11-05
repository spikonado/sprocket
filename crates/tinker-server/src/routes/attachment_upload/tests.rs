use super::*;
use axum::body::{Body, Bytes};

#[tokio::test]
async fn stages_large_binary_uploads_without_a_body_size_limit() {
    let temp = tempfile::NamedTempFile::new().unwrap();
    let chunks = futures::stream::iter(
        (0..12).map(|_| Ok::<_, std::io::Error>(Bytes::from(vec![0xff; 1024 * 1024]))),
    );
    let size = stage_body(Body::from_stream(chunks), temp.path())
        .await
        .unwrap();
    assert_eq!(size, 12 * 1024 * 1024);
    assert_eq!(tokio::fs::metadata(temp.path()).await.unwrap().len(), size);
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
