use std::path::Path;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use tower::ServiceExt;

use super::super::routes;
use super::*;

async fn image_test_app(data_dir: &Path) -> (axum::Router, String) {
    let auth = crate::auth::AuthState::load(data_dir).unwrap();
    let (_, token) = auth.bootstrap_browser_session(true).await.unwrap();
    auth.bind_session_user(&token, "test-user").await.unwrap();
    let native_auth = crate::native_auth::NativeAuthManager::configured_for_test(
        crate::native_auth::NativeAuthConfig {
            workos_client_id: "client_test".to_string(),
        },
        crate::auth::desktop_login_callback_url(7731),
    );
    let state = AppState::for_test(
        auth,
        native_auth,
        data_dir.to_path_buf(),
        true,
        crate::package_update::PackageUpdateManager::disabled(),
    );
    (routes().with_state(state), token)
}

fn image_request(workspace: Option<&Path>, path: &str, token: Option<&str>) -> Request<Body> {
    image_request_with_options(workspace, path, token, &[])
}

fn image_request_with_options(
    workspace: Option<&Path>,
    path: &str,
    token: Option<&str>,
    options: &[(&str, &str)],
) -> Request<Body> {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    if let Some(workspace) = workspace {
        query.append_pair("workspacePath", &workspace.to_string_lossy());
    }
    for (key, value) in options {
        query.append_pair(key, value);
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
async fn local_image_prefers_workspace_images_and_scopes_missing_paths_to_transcript_threads() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let transcript = sprocket_agent::TranscriptStore::new(data.path().join("transcripts"));
    let path = "parse_file/550e8400-e29b-41d4-a716-446655440000.png";
    let first = b"\x89PNG\r\n\x1a\nfirst";
    let second = b"\x89PNG\r\n\x1a\nsecond";
    let workspace_image = b"\x89PNG\r\n\x1a\nworkspace";
    std::fs::create_dir(workspace.path().join("parse_file")).unwrap();
    let workspace_image_path = workspace.path().join(path);
    std::fs::write(&workspace_image_path, workspace_image).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&workspace_image_path)
        .unwrap()
        .set_times(
            std::fs::FileTimes::new()
                .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(3)),
        )
        .unwrap();
    let (app, token) = image_test_app(data.path()).await;

    for (thread_id, contents, seconds) in
        [("thread_1", &first[..], 1), ("thread-2", &second[..], 2)]
    {
        let thread_dir = transcript.thread_dir("test-user", thread_id);
        std::fs::create_dir_all(thread_dir.join("parse_file")).unwrap();
        let image_path = thread_dir.join(path);
        std::fs::write(&image_path, contents).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&image_path)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds)),
            )
            .unwrap();

        for workspace_root in [Some(workspace.path()), None] {
            let (expected_contents, expected_seconds) = if workspace_root.is_some() {
                (&workspace_image[..], 3)
            } else {
                (contents, seconds)
            };
            for revision_only in [false, true] {
                let response = app
                    .clone()
                    .oneshot(image_request_with_options(
                        workspace_root,
                        path,
                        Some(&token),
                        &[
                            ("userId", "test-user"),
                            ("threadId", thread_id),
                            ("revisionOnly", if revision_only { "true" } else { "false" }),
                        ],
                    ))
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
                if !revision_only {
                    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
                    assert_eq!(
                        response.headers()[header::X_CONTENT_TYPE_OPTIONS],
                        "nosniff"
                    );
                }
                let body = to_bytes(response.into_body(), 1024).await.unwrap();
                if revision_only {
                    let revision = serde_json::from_slice::<String>(&body).unwrap();
                    assert_eq!(
                        revision,
                        format!(
                            "{}-{}",
                            expected_contents.len(),
                            expected_seconds * 1_000_000_000
                        )
                    );
                } else {
                    assert_eq!(body.as_ref(), expected_contents);
                }
            }
        }
    }

    std::fs::remove_file(&workspace_image_path).unwrap();
    for (thread_id, expected_contents) in [("thread_1", &first[..]), ("thread-2", &second[..])] {
        for revision_only in ["false", "true"] {
            let response = app
                .clone()
                .oneshot(image_request_with_options(
                    Some(workspace.path()),
                    path,
                    Some(&token),
                    &[
                        ("userId", "test-user"),
                        ("threadId", thread_id),
                        ("revisionOnly", revision_only),
                    ],
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = to_bytes(response.into_body(), 1024).await.unwrap();
            if revision_only == "true" {
                let metadata =
                    std::fs::metadata(transcript.thread_dir("test-user", thread_id).join(path))
                        .unwrap();
                let nanos = metadata
                    .modified()
                    .unwrap()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                assert_eq!(
                    serde_json::from_slice::<String>(&body).unwrap(),
                    format!("{}-{nanos}", expected_contents.len())
                );
            } else {
                assert_eq!(body.as_ref(), expected_contents);
            }
        }
    }
    std::fs::write(&workspace_image_path, workspace_image).unwrap();

    let unscoped = app
        .clone()
        .oneshot(image_request(Some(workspace.path()), path, Some(&token)))
        .await
        .unwrap();
    assert_eq!(unscoped.status(), StatusCode::OK);
    let body = to_bytes(unscoped.into_body(), 1024).await.unwrap();
    assert_eq!(body.as_ref(), &workspace_image[..]);

    for revision_only in [false, true] {
        let missing = app
            .clone()
            .oneshot(image_request_with_options(
                None,
                path,
                Some(&token),
                &[
                    ("userId", "test-user"),
                    ("threadId", "missing-thread"),
                    ("revisionOnly", if revision_only { "true" } else { "false" }),
                ],
            ))
            .await
            .unwrap();
        if revision_only {
            assert_eq!(missing.status(), StatusCode::OK);
            let body = to_bytes(missing.into_body(), 1024).await.unwrap();
            assert_eq!(body.as_ref(), b"null");
        } else {
            assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
        }
    }
}

#[tokio::test]
async fn local_image_serves_workspace_images_when_the_thread_cache_file_is_missing() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let transcript = sprocket_agent::TranscriptStore::new(data.path().join("transcripts"));
    let thread_dir = transcript.thread_dir("test-user", "thread-1");
    let path = "parse_file/board.png";
    let contents = b"\x89PNG\r\n\x1a\nworkspace";
    std::fs::create_dir(workspace.path().join("parse_file")).unwrap();
    std::fs::write(workspace.path().join(path), contents).unwrap();
    let (app, token) = image_test_app(data.path()).await;

    for cache_directory_exists in [false, true] {
        if cache_directory_exists {
            std::fs::create_dir_all(thread_dir.join("parse_file")).unwrap();
        }
        for revision_only in ["false", "true"] {
            let response = app
                .clone()
                .oneshot(image_request_with_options(
                    Some(workspace.path()),
                    path,
                    Some(&token),
                    &[
                        ("userId", "test-user"),
                        ("threadId", "thread-1"),
                        ("revisionOnly", revision_only),
                    ],
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = to_bytes(response.into_body(), 1024).await.unwrap();
            if revision_only == "true" {
                let revision = serde_json::from_slice::<String>(&body).unwrap();
                let metadata = std::fs::metadata(workspace.path().join(path)).unwrap();
                let nanos = metadata
                    .modified()
                    .unwrap()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                assert_eq!(revision, format!("{}-{nanos}", contents.len()));
            } else {
                assert_eq!(body.as_ref(), contents);
            }
        }
    }
}

#[tokio::test]
async fn local_image_serves_each_thread_image_tool_cache() {
    let data = tempfile::tempdir().unwrap();
    let transcript = sprocket_agent::TranscriptStore::new(data.path().join("transcripts"));
    let thread_dir = transcript.thread_dir("test-user", "thread-1");
    let (app, token) = image_test_app(data.path()).await;
    let contents = b"\x89PNG\r\n\x1a\n";
    for tool in ["parse_file", "screenshot_url", "scrape_url"] {
        std::fs::create_dir_all(thread_dir.join(tool)).unwrap();
        let path = format!("{tool}/photo.png");
        std::fs::write(thread_dir.join(&path), contents).unwrap();
        let response = app
            .clone()
            .oneshot(image_request_with_options(
                None,
                &path,
                Some(&token),
                &[("userId", "test-user"), ("threadId", "thread-1")],
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
            contents
        );
    }
}

#[tokio::test]
async fn local_image_rejects_incomplete_scopes_and_mismatched_session_users() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    std::fs::create_dir(workspace.path().join("parse_file")).unwrap();
    std::fs::write(
        workspace.path().join("parse_file/photo.png"),
        b"\x89PNG\r\n\x1a\n",
    )
    .unwrap();
    let (app, token) = image_test_app(data.path()).await;

    for revision_only in ["false", "true"] {
        for (user_id, thread_id, session_token, expected_status) in [
            (
                Some("test-user"),
                None,
                Some(token.as_str()),
                StatusCode::BAD_REQUEST,
            ),
            (
                None,
                Some("thread-1"),
                Some(token.as_str()),
                StatusCode::BAD_REQUEST,
            ),
            (
                Some("other-user"),
                Some("thread-1"),
                Some(token.as_str()),
                StatusCode::UNAUTHORIZED,
            ),
            (
                Some(""),
                Some("thread-1"),
                Some(token.as_str()),
                StatusCode::UNAUTHORIZED,
            ),
            (
                Some("test-user"),
                Some("thread-1"),
                None,
                StatusCode::UNAUTHORIZED,
            ),
        ] {
            let mut options = vec![("revisionOnly", revision_only)];
            if let Some(user_id) = user_id {
                options.push(("userId", user_id));
            }
            if let Some(thread_id) = thread_id {
                options.push(("threadId", thread_id));
            }
            let response = app
                .clone()
                .oneshot(image_request_with_options(
                    Some(workspace.path()),
                    "parse_file/photo.png",
                    session_token,
                    &options,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), expected_status, "{options:?}");
        }
    }
}

#[tokio::test]
async fn local_image_rejects_unsafe_thread_ids_and_scoped_paths() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let (app, token) = image_test_app(data.path()).await;
    let absolute_path = workspace.path().join("parse_file/photo.png");
    let absolute_path = absolute_path.to_str().unwrap();
    let mut cases = vec![
        ("thread-1", ""),
        ("thread-1", "parse_file"),
        ("thread-1", "parse_file/"),
        ("thread-1", "images/photo.png"),
        ("thread-1", "parse_file_other/photo.png"),
        ("thread-1", "../parse_file/photo.png"),
        ("thread-1", "./parse_file/photo.png"),
        ("thread-1", "parse_file/../photo.png"),
        ("thread-1", "parse_file/./photo.png"),
        ("thread-1", "parse_file/nested/../../photo.png"),
        ("thread-1", "parse_file/..\\photo.png"),
        ("thread-1", "/parse_file/photo.png"),
        ("thread-1", absolute_path),
    ];
    for thread_id in [
        "",
        "blobs",
        "BLOBS",
        "pending-attachments",
        "Pending-Attachments",
        "..",
        "thread/1",
        "thread\\1",
        "thread.1",
        "thread:1",
        "thread 1",
        "thréad",
    ] {
        cases.push((thread_id, "parse_file/photo.png"));
    }
    for revision_only in ["false", "true"] {
        for (thread_id, path) in &cases {
            let response = app
                .clone()
                .oneshot(image_request_with_options(
                    Some(workspace.path()),
                    path,
                    Some(&token),
                    &[
                        ("userId", "test-user"),
                        ("threadId", thread_id),
                        ("revisionOnly", revision_only),
                    ],
                ))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "{thread_id:?}: {path}"
            );
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn local_image_rejects_thread_images_linked_outside_the_transcript_directory() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let transcript = sprocket_agent::TranscriptStore::new(data.path().join("transcripts"));
    let thread_dir = transcript.thread_dir("test-user", "thread-1");
    std::fs::create_dir_all(thread_dir.join("parse_file")).unwrap();
    let outside_image = workspace.path().join("outside.png");
    std::fs::write(&outside_image, b"\x89PNG\r\n\x1a\n").unwrap();
    std::os::unix::fs::symlink(&outside_image, thread_dir.join("parse_file/linked.png")).unwrap();
    let (app, token) = image_test_app(data.path()).await;
    let response = app
        .oneshot(image_request_with_options(
            Some(workspace.path()),
            "parse_file/linked.png",
            Some(&token),
            &[("userId", "test-user"), ("threadId", "thread-1")],
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn local_image_revision_tracks_overwrites_and_missing_files_without_reading_contents() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let path = workspace.path().join("board.png");
    let (app, token) = image_test_app(data.path()).await;
    let revision_request = |token: Option<&str>| {
        let mut request = image_request(Some(workspace.path()), "board.png", token);
        *request.uri_mut() = format!("{}&revisionOnly=true", request.uri())
            .parse()
            .unwrap();
        request
    };
    let denied = app.clone().oneshot(revision_request(None)).await.unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let missing = app
        .clone()
        .oneshot(revision_request(Some(&token)))
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::OK);
    assert_eq!(missing.headers()[header::CACHE_CONTROL], "no-store");
    let contents = to_bytes(missing.into_body(), 1024).await.unwrap();
    assert_eq!(contents.as_ref(), b"null");

    let mut revisions = Vec::new();
    for (contents, seconds) in [(b"first", 1), (b"other", 2)] {
        std::fs::write(&path, contents).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds)),
            )
            .unwrap();
        let response = app
            .clone()
            .oneshot(revision_request(Some(&token)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        revisions.push(serde_json::from_slice::<String>(&body).unwrap());
    }
    assert_ne!(revisions[0], revisions[1]);
    let image = app
        .oneshot(image_request(
            Some(workspace.path()),
            "board.png",
            Some(&token),
        ))
        .await
        .unwrap();
    assert_eq!(image.status(), StatusCode::BAD_REQUEST);
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
