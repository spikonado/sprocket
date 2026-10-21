use std::path::Path;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use tower::ServiceExt;

use super::super::routes;
use super::*;
use crate::AppState;

async fn image_test_app(data_dir: &Path) -> (axum::Router, String) {
    let auth = crate::auth::AuthState::load(data_dir).unwrap();
    let (_, token) = auth.bootstrap_browser_session(true).await.unwrap();
    auth.bind_session_user(&token, "test-user").await.unwrap();
    let native_auth = sprocket_host::native_auth::NativeAuthManager::configured_for_test(
        sprocket_host::native_auth::NativeAuthConfig {
            workos_client_id: "client_test".to_string(),
        },
        crate::auth::desktop_login_callback_url(7731),
    );
    let state = AppState::for_test(
        auth,
        native_auth,
        data_dir.to_path_buf(),
        true,
        sprocket_host::package_update::PackageUpdateManager::disabled(),
    );
    (routes().with_state(state), token)
}

fn image_request(workspace: Option<&Path>, path: &str, token: Option<&str>) -> Request<Body> {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    if let Some(workspace) = workspace {
        query.append_pair("workspacePath", &workspace.to_string_lossy());
    }
    let query = query.append_pair("path", path).finish();
    let uri = format!("/workspace/image?{query}");
    let mut builder = Request::builder().method("GET").uri(uri);
    if let Some(token) = token {
        builder = builder.header(
            "cookie",
            format!("{}={token}", crate::config::SESSION_COOKIE_NAME),
        );
    }
    builder.body(Body::empty()).unwrap()
}

#[tokio::test]
async fn local_image_serves_relative_and_absolute_images_without_an_attachment() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let image = b"\x89PNG\r\n\x1a\npng-data";
    std::fs::create_dir(workspace.path().join("images")).unwrap();
    std::fs::write(workspace.path().join("images/photo.bin"), image).unwrap();
    std::fs::write(
        workspace.path().join("images/vector.svg"),
        b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
    )
    .unwrap();
    let (app, token) = image_test_app(data.path()).await;

    let denied = app
        .clone()
        .oneshot(image_request(
            Some(workspace.path()),
            "images/photo.bin",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

    let mut paths = vec![
        "images/photo.bin".to_string(),
        workspace
            .path()
            .join("images/photo.bin")
            .to_string_lossy()
            .into_owned(),
    ];
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            workspace.path().join("images/photo.bin"),
            workspace.path().join("images/internal-link.png"),
        )
        .unwrap();
        paths.push("images/internal-link.png".to_string());
    }
    for path in paths {
        let response = app
            .clone()
            .oneshot(image_request(Some(workspace.path()), &path, Some(&token)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        let contents = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(contents.as_ref(), &image[..]);
    }

    let svg = app
        .oneshot(image_request(
            Some(workspace.path()),
            "images/vector.svg",
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(svg.status(), StatusCode::OK);
    assert_eq!(svg.headers()[header::CONTENT_TYPE], "image/svg+xml");
    assert_eq!(
        svg.headers().get("content-security-policy").unwrap(),
        "sandbox; default-src 'none'"
    );
}

#[tokio::test]
async fn local_image_serves_images_outside_the_workspace() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("outside.png"), b"\x89PNG\r\n\x1a\n").unwrap();
    let (app, token) = image_test_app(data.path()).await;

    let traversal_path = Path::new("..")
        .join(outside.path().file_name().unwrap())
        .join("outside.png");
    for (base, path) in [
        (Some(workspace.path()), traversal_path),
        (None, outside.path().join("outside.png")),
    ] {
        let response = app
            .clone()
            .oneshot(image_request(base, &path.to_string_lossy(), Some(&token)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        let contents = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(contents.as_ref(), b"\x89PNG\r\n\x1a\n");
    }

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            outside.path().join("outside.png"),
            workspace.path().join("linked.png"),
        )
        .unwrap();
        let linked_image = app
            .oneshot(image_request(
                Some(workspace.path()),
                "linked.png",
                Some(&token),
            ))
            .await
            .unwrap();
        assert_eq!(linked_image.status(), StatusCode::OK);
    }
}

#[tokio::test]
async fn local_image_rejects_unsupported_oversized_or_nonregular_files() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("fake.png"), b"not an image").unwrap();
    std::fs::File::create(workspace.path().join("oversized.png"))
        .unwrap()
        .set_len(MAX_LOCAL_IMAGE_BYTES + 1)
        .unwrap();
    std::fs::create_dir(workspace.path().join("directory.png")).unwrap();
    let (app, token) = image_test_app(data.path()).await;

    for path in ["fake.png", "oversized.png", "directory.png"] {
        let response = app
            .clone()
            .oneshot(image_request(Some(workspace.path()), path, Some(&token)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{path}");
    }
}

#[test]
fn image_sniffing_recognizes_supported_formats_and_sandboxes_svg() {
    let avif = [
        0, 0, 0, 16, b'f', b't', b'y', b'p', b'a', b'v', b'i', b'f', 0, 0, 0, 0,
    ];
    for (contents, expected_type) in [
        (&b"\x89PNG\r\n\x1a\n"[..], "image/png"),
        (&b"\xff\xd8\xff\x00"[..], "image/jpeg"),
        (&b"GIF89a"[..], "image/gif"),
        (&b"RIFF\x04\x00\x00\x00WEBP"[..], "image/webp"),
        (&b"BM"[..], "image/bmp"),
        (&avif[..], "image/avif"),
        (
            &b"<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"/>"[..],
            "image/svg+xml",
        ),
        (
            &b"<?xml version=\"1.0\"?><!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\"><svg/>"[..],
            "image/svg+xml",
        ),
        (
            &b"<!DOCTYPE svg [<!ENTITY label \"Board > layout\">]><svg/>"[..],
            "image/svg+xml",
        ),
    ] {
        assert_eq!(detect_image_media_type(contents), Some(expected_type));
    }
    assert_eq!(detect_image_media_type(b"plain text"), None);
}
