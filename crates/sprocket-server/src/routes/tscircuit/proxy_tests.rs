use super::*;
use crate::test_support::{cookie_request, signed_in_state};
use axum::routing::get;
use tower::ServiceExt;

#[tokio::test]
async fn editor_requires_the_signed_in_user_and_starting_requires_same_origin() {
    let (state, token, _directory) = signed_in_state().await;
    let app = crate::build_router(state, None);
    let response = app
        .clone()
        .oneshot(cookie_request(
            "/api/tscircuit/dev/ab12/",
            None,
            None,
            Method::GET,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let mut request = cookie_request("/api/tscircuit/dev", Some(&token), None, Method::POST);
    *request.body_mut() = Body::from(r#"{"workspacePath":"/tmp","path":"a.circuit.tsx"}"#);
    request.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn serves_the_editor_through_the_proxy_with_its_policy() {
    let (state, token, _directory) = signed_in_state().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let upstream = axum::Router::new().route(
        "/",
        get(move |headers: HeaderMap| async move {
            assert!(!headers.contains_key(header::COOKIE));
            (
                [(header::CONTENT_TYPE, "text/html")],
                format!(r#"BASE_URL = "http://127.0.0.1:{port}/api";<script src="/standalone.min.js"></script>"#),
            )
        }),
    );
    let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    state.host.tscircuit_dev.use_test_server("ab12", port).await;
    let response = crate::build_router(state, None)
        .oneshot(cookie_request(
            "/api/tscircuit/dev/ab12/",
            Some(&token),
            None,
            Method::GET,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_SECURITY_POLICY],
        CONTENT_SECURITY_POLICY
    );
    let bytes = axum::body::to_bytes(response.into_body(), 1024)
        .await
        .unwrap();
    assert_eq!(
        &bytes[..],
        br#"BASE_URL = "/api/tscircuit/dev/ab12/api";<script src="/api/tscircuit/dev/ab12/standalone.min.js"></script>"#
    );
    task.abort();
}
