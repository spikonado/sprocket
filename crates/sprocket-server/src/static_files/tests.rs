use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use axum::response::Response;
use tower::ServiceExt;

use super::{resolve_static_file, static_router};

const INDEX: &str = "index-shell";
const PAIR: &str = "pair-page";
const CALLBACK: &str = "callback-page";
const VERSION: &str = "{\"version\":\"test\"}";
const ENV: &str = "window.env={}";
const CHUNK: &str = "immutable-chunk";

const NO_CACHE: &str = "no-cache";
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const NO_STORE: &str = "no-store";

fn web_dist() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("_app/immutable")).unwrap();
    std::fs::write(root.join("index.html"), INDEX).unwrap();
    std::fs::write(root.join("pair.html"), PAIR).unwrap();
    std::fs::write(root.join("callback.html"), CALLBACK).unwrap();
    std::fs::write(root.join("_app/version.json"), VERSION).unwrap();
    std::fs::write(root.join("_app/env.js"), ENV).unwrap();
    std::fs::write(root.join("_app/immutable/chunk.js"), CHUNK).unwrap();
    dir
}

fn fixture() -> (tempfile::TempDir, Router) {
    let dir = web_dist();
    let app = static_router(
        dir.path().to_path_buf(),
        Router::new()
            .route("/ping", axum::routing::get(|| async { "pong" }))
            .fallback(|| async { StatusCode::NOT_FOUND }),
    );
    (dir, app)
}

async fn call(app: &Router, request: Request<Body>) -> Response {
    app.clone().oneshot(request).await.unwrap()
}

async fn body_bytes(response: Response) -> Vec<u8> {
    axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec()
}

fn cache_control(response: &Response) -> &str {
    response
        .headers()
        .get(header::CACHE_CONTROL)
        .expect("Cache-Control")
        .to_str()
        .unwrap()
}

fn get(uri: &str) -> Request<Body> {
    Request::builder().uri(uri).body(Body::empty()).unwrap()
}

#[test]
fn resolves_prerendered_html_routes() {
    let dist = web_dist();
    let dir = dist.path();

    assert_eq!(resolve_static_file(dir, "/"), Some(dir.join("index.html")));
    assert_eq!(
        resolve_static_file(dir, "/index.html"),
        Some(dir.join("index.html"))
    );
    assert_eq!(
        resolve_static_file(dir, "/pair"),
        Some(dir.join("pair.html"))
    );
    assert_eq!(
        resolve_static_file(dir, "/callback"),
        Some(dir.join("callback.html"))
    );
    assert_eq!(resolve_static_file(dir, "/unknown"), None);
}

#[test]
fn rejects_path_traversal_and_absolute_segments() {
    let dist = web_dist();
    let dir = dist.path();

    assert_eq!(resolve_static_file(dir, "/../Cargo.toml"), None);
    assert_eq!(resolve_static_file(dir, "/foo/../../Cargo.toml"), None);
    assert_eq!(resolve_static_file(dir, "/./pair"), None);
    // `C:` is a Prefix component only on Windows. On Unix it is a normal
    // path segment, so drive-style rejection is Windows-only.
    #[cfg(windows)]
    assert_eq!(resolve_static_file(dir, "/C:/Windows/win.ini"), None);
}

#[tokio::test]
async fn successful_static_responses_set_cache_control() {
    let (_dir, app) = fixture();
    let cases = [
        ("/", INDEX, NO_CACHE),
        ("/index.html", INDEX, NO_CACHE),
        ("/pair", PAIR, NO_CACHE),
        ("/callback", CALLBACK, NO_CACHE),
        ("/unknown-spa-route", INDEX, NO_CACHE),
        ("/_app/version.json", VERSION, NO_CACHE),
        ("/_app/env.js", ENV, NO_CACHE),
        ("/_app/immutable/chunk.js", CHUNK, IMMUTABLE),
    ];

    for (path, expected_body, policy) in cases {
        let response = call(&app, get(path)).await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(cache_control(&response), policy, "{path}");
        assert_eq!(
            body_bytes(response).await,
            expected_body.as_bytes(),
            "{path}"
        );
    }
}

#[tokio::test]
async fn revalidation_returns_304_with_the_same_cache_policy() {
    let (_dir, app) = fixture();
    let cases = [
        ("/", NO_CACHE),
        ("/unknown-spa-route", NO_CACHE),
        ("/_app/version.json", NO_CACHE),
        ("/_app/immutable/chunk.js", IMMUTABLE),
    ];

    for (path, policy) in cases {
        let first = call(&app, get(path)).await;
        assert_eq!(first.status(), StatusCode::OK, "{path}");
        assert_eq!(cache_control(&first), policy, "{path}");

        let mut builder = Request::builder().uri(path);
        if let Some(etag) = first.headers().get(header::ETAG).cloned() {
            builder = builder.header(header::IF_NONE_MATCH, etag);
        } else if let Some(last_modified) = first.headers().get(header::LAST_MODIFIED).cloned() {
            builder = builder.header(header::IF_MODIFIED_SINCE, last_modified);
        } else {
            panic!("{path}: expected ETag or Last-Modified");
        }

        let response = call(&app, builder.body(Body::empty()).unwrap()).await;
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED, "{path}");
        assert_eq!(cache_control(&response), policy, "{path}");
        assert!(body_bytes(response).await.is_empty(), "{path}");
    }
}

#[tokio::test]
async fn head_responses_have_empty_bodies() {
    let (_dir, app) = fixture();
    let cases = [
        ("/", NO_CACHE),
        ("/unknown-spa-route", NO_CACHE),
        ("/_app/immutable/chunk.js", IMMUTABLE),
    ];

    for (path, policy) in cases {
        let response = call(
            &app,
            Request::builder()
                .method("HEAD")
                .uri(path)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(cache_control(&response), policy, "{path}");
        assert!(body_bytes(response).await.is_empty(), "{path}");
    }
}

#[tokio::test]
async fn static_errors_use_no_store_and_missing_immutable_is_not_spa_html() {
    let (_dir, app) = fixture();

    for path in ["/_app/immutable/missing.js", "/_app/missing.js"] {
        let response = call(&app, get(path)).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        assert_eq!(cache_control(&response), NO_STORE, "{path}");
        assert_ne!(body_bytes(response).await, INDEX.as_bytes(), "{path}");
    }
}

#[tokio::test]
async fn api_responses_do_not_get_static_cache_headers() {
    let (_dir, app) = fixture();

    let ok = call(&app, get("/api/ping")).await;
    assert_eq!(ok.status(), StatusCode::OK);
    assert!(ok.headers().get(header::CACHE_CONTROL).is_none());
    assert_eq!(body_bytes(ok).await, b"pong");

    let missing = call(&app, get("/api/missing")).await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    assert!(missing.headers().get(header::CACHE_CONTROL).is_none());
}
