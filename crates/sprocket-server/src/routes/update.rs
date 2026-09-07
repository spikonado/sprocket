use std::net::SocketAddr;

use axum::Json;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum_extra::extract::CookieJar;

use crate::AppState;
use crate::auth::{cookie_get_is_csrf_safe, cookie_request_is_loopback_csrf_safe, require_session};
use crate::package_update::PackageUpdateSnapshot;
use crate::routes::api_error::ApiError;

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/update", get(status))
        .route("/update/install", post(install))
}

async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<Response, ApiError> {
    require_update_read(&state, &headers, &jar).await?;
    Ok(update_response(state.package_updates.status().await))
}

async fn install(
    State(state): State<AppState>,
    peer: Result<ConnectInfo<SocketAddr>, axum::extract::rejection::ExtensionRejection>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<Response, ApiError> {
    let peer = peer.ok().map(|ConnectInfo(peer)| peer);
    require_update_install(&state, peer, &headers, &jar).await?;
    Ok(update_response(state.package_updates.install().await))
}

async fn require_update_read(
    state: &AppState,
    headers: &HeaderMap,
    jar: &CookieJar,
) -> Result<(), ApiError> {
    require_session(&state.auth, headers, jar)
        .await
        .map_err(|_| ApiError::authentication_required())?;
    if !cookie_get_is_csrf_safe(headers) {
        return Err(cross_origin_rejected());
    }
    Ok(())
}

async fn require_update_install(
    state: &AppState,
    peer: Option<SocketAddr>,
    headers: &HeaderMap,
    jar: &CookieJar,
) -> Result<(), ApiError> {
    require_session(&state.auth, headers, jar)
        .await
        .map_err(|_| ApiError::authentication_required())?;
    if !peer.is_some_and(|peer| peer.ip().is_loopback())
        || !cookie_request_is_loopback_csrf_safe(headers)
    {
        return Err(ApiError::with_status(
            StatusCode::FORBIDDEN,
            anyhow::anyhow!("package updates can only be installed from this machine"),
        ));
    }
    Ok(())
}

fn cross_origin_rejected() -> ApiError {
    ApiError::with_status(
        StatusCode::FORBIDDEN,
        anyhow::anyhow!("cross-origin request rejected"),
    )
}

fn update_response(snapshot: PackageUpdateSnapshot) -> Response {
    let mut response = Json(snapshot).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use std::sync::Arc;

    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Request, header};
    use tower::ServiceExt;
    use uuid::Uuid;

    use super::*;
    use crate::auth;
    use crate::package_update::PackageUpdateManager;

    async fn test_state(package_updates: Arc<PackageUpdateManager>) -> (AppState, String) {
        let temp_dir =
            std::env::temp_dir().join(format!("sprocket-update-route-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let auth = auth::AuthState::load(&temp_dir).expect("auth state");
        let credential = auth.pairing_credential().to_string();
        let (_, session_token) = auth.bootstrap(&credential).await.expect("bootstrap");
        let native_auth = crate::native_auth::NativeAuthManager::configured_for_test(
            crate::native_auth::NativeAuthConfig {
                workos_client_id: "client_test".to_string(),
            },
            auth::desktop_login_callback_url(7731),
        );
        let state = AppState::for_test(auth, native_auth, temp_dir, true, package_updates);
        (state, session_token)
    }

    fn router(state: AppState) -> axum::Router {
        crate::build_router(state, None)
    }

    async fn read_json(response: axum::http::Response<Body>) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        serde_json::from_slice(&bytes).expect("json")
    }

    fn session_cookie(session_token: &str) -> String {
        format!("{}={session_token}", crate::SESSION_COOKIE_NAME)
    }

    fn loopback_peer() -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 54321)
    }

    fn lan_peer() -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50)), 54321)
    }

    fn with_peer(mut request: Request<Body>, peer: SocketAddr) -> Request<Body> {
        request.extensions_mut().insert(ConnectInfo(peer));
        request
    }

    fn status_request(session_token: Option<&str>, origin: Option<&str>) -> Request<Body> {
        let mut request = Request::builder()
            .method("GET")
            .uri("/api/update")
            .header(header::HOST, "127.0.0.1:7731");
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        if let Some(session_token) = session_token {
            request = request.header(header::COOKIE, session_cookie(session_token));
        }
        request.body(Body::empty()).unwrap()
    }

    fn install_request(
        session_token: Option<&str>,
        origin: Option<&str>,
        body: &'static str,
    ) -> Request<Body> {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/update/install")
            .header(header::HOST, "127.0.0.1:7731")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        if let Some(session_token) = session_token {
            request = request.header(header::COOKIE, session_cookie(session_token));
        }
        request.body(Body::from(body)).unwrap()
    }

    #[tokio::test]
    async fn update_status_requires_session_and_rejects_hostile_origin() {
        let (state, session_token) = test_state(PackageUpdateManager::disabled()).await;
        let app = router(state);

        let unauthenticated = app
            .clone()
            .oneshot(status_request(None, Some("http://127.0.0.1:7731")))
            .await
            .unwrap();
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

        let missing_origin = app
            .clone()
            .oneshot(status_request(Some(&session_token), None))
            .await
            .unwrap();
        assert_eq!(missing_origin.status(), StatusCode::OK);
        assert_eq!(missing_origin.headers()[header::CACHE_CONTROL], "no-store");
        let payload = read_json(missing_origin).await;
        assert_eq!(payload["status"], "unavailable");
        assert_eq!(payload["method"], "package");

        let cross_origin = app
            .clone()
            .oneshot(status_request(
                Some(&session_token),
                Some("https://attacker.example"),
            ))
            .await
            .unwrap();
        assert_eq!(cross_origin.status(), StatusCode::FORBIDDEN);

        let ok = app
            .oneshot(status_request(
                Some(&session_token),
                Some("http://127.0.0.1:7731"),
            ))
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::OK);
        let payload = read_json(ok).await;
        assert_eq!(payload["status"], "unavailable");
    }

    #[tokio::test]
    async fn install_requires_session_loopback_and_same_origin() {
        let (state, session_token) = test_state(PackageUpdateManager::disabled()).await;
        let app = router(state);

        let unauthenticated = app
            .clone()
            .oneshot(with_peer(
                install_request(None, Some("http://127.0.0.1:7731"), "{}"),
                loopback_peer(),
            ))
            .await
            .unwrap();
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

        let missing_origin = app
            .clone()
            .oneshot(with_peer(
                install_request(Some(&session_token), None, "{}"),
                loopback_peer(),
            ))
            .await
            .unwrap();
        assert_eq!(missing_origin.status(), StatusCode::FORBIDDEN);

        let cross_origin = app
            .clone()
            .oneshot(with_peer(
                install_request(Some(&session_token), Some("https://attacker.example"), "{}"),
                loopback_peer(),
            ))
            .await
            .unwrap();
        assert_eq!(cross_origin.status(), StatusCode::FORBIDDEN);

        let lan = app
            .oneshot(with_peer(
                install_request(Some(&session_token), Some("http://127.0.0.1:7731"), "{}"),
                lan_peer(),
            ))
            .await
            .unwrap();
        assert_eq!(lan.status(), StatusCode::FORBIDDEN);
    }
}

#[cfg(all(test, unix))]
mod process_tests {
    use std::fs;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::Duration;

    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Request, header};
    use tower::ServiceExt;
    use uuid::Uuid;

    use super::*;
    use crate::auth;
    use crate::package_update::PackageUpdateManager;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("sprocket-update-route-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_helper(dir: &Path, body: &str) -> Arc<PackageUpdateManager> {
        let script = dir.join("update-api.sh");
        fs::write(&script, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        PackageUpdateManager::with_helper_and_timeouts(
            PathBuf::from("/bin/sh"),
            script,
            Duration::from_secs(60),
            Duration::from_secs(5),
            Duration::from_secs(5),
            Duration::from_secs(5),
        )
    }

    async fn test_state(package_updates: Arc<PackageUpdateManager>) -> (AppState, String, TempDir) {
        let temp_dir = TempDir::new();
        let auth = auth::AuthState::load(&temp_dir.0).expect("auth state");
        let credential = auth.pairing_credential().to_string();
        let (_, session_token) = auth.bootstrap(&credential).await.expect("bootstrap");
        let native_auth = crate::native_auth::NativeAuthManager::configured_for_test(
            crate::native_auth::NativeAuthConfig {
                workos_client_id: "client_test".to_string(),
            },
            auth::desktop_login_callback_url(7731),
        );
        let state =
            AppState::for_test(auth, native_auth, temp_dir.0.clone(), true, package_updates);
        (state, session_token, temp_dir)
    }

    fn router(state: AppState) -> axum::Router {
        crate::build_router(state, None)
    }

    async fn read_json(response: axum::http::Response<Body>) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        serde_json::from_slice(&bytes).expect("json")
    }

    fn session_cookie(session_token: &str) -> String {
        format!("{}={session_token}", crate::SESSION_COOKIE_NAME)
    }

    fn loopback_peer() -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 54321)
    }

    fn with_peer(mut request: Request<Body>, peer: SocketAddr) -> Request<Body> {
        request.extensions_mut().insert(ConnectInfo(peer));
        request
    }

    fn status_request(session_token: Option<&str>, origin: Option<&str>) -> Request<Body> {
        let mut request = Request::builder()
            .method("GET")
            .uri("/api/update")
            .header(header::HOST, "127.0.0.1:7731");
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        if let Some(session_token) = session_token {
            request = request.header(header::COOKIE, session_cookie(session_token));
        }
        request.body(Body::empty()).unwrap()
    }

    fn install_request(
        session_token: Option<&str>,
        origin: Option<&str>,
        body: &'static str,
    ) -> Request<Body> {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/update/install")
            .header(header::HOST, "127.0.0.1:7731")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        if let Some(session_token) = session_token {
            request = request.header(header::COOKIE, session_cookie(session_token));
        }
        request.body(Body::from(body)).unwrap()
    }

    #[tokio::test]
    async fn bearer_status_skips_origin_and_does_not_install() {
        let helper_dir = TempDir::new();
        let manager = write_helper(
            &helper_dir.0,
            r#"printf '%s\n' "$1" >> "$(dirname "$0")/calls"
echo '{"status":"available","currentVersion":"1.0.0","version":"1.1.0","error":null,"method":"package"}'"#,
        );
        let (state, session_token, _dir) = test_state(manager).await;
        let app = router(state);
        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/update")
                    .header(header::HOST, "127.0.0.1:7731")
                    .header(header::AUTHORIZATION, format!("Bearer {session_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let payload = read_json(response).await;
        assert_eq!(payload["status"], "available");
        assert_eq!(
            fs::read_to_string(helper_dir.0.join("calls")).unwrap(),
            "check\n"
        );
    }

    #[tokio::test]
    async fn install_starts_without_using_request_body_and_returns_installing() {
        let helper_dir = TempDir::new();
        let manager = write_helper(
            &helper_dir.0,
            r#"printf '%s\n' "$1" >> "$(dirname "$0")/calls"
while [ ! -f "$(dirname "$0")/finish" ]; do sleep 0.02; done
echo '{"status":"installed","currentVersion":"1.1.0","version":"1.1.0","error":null,"method":"package"}'"#,
        );
        let (state, session_token, _dir) = test_state(Arc::clone(&manager)).await;
        let app = router(state);

        let ok = app
            .clone()
            .oneshot(with_peer(
                install_request(
                    Some(&session_token),
                    Some("http://127.0.0.1:7731"),
                    r#"{"command":"rm -rf /","args":["--force"]}"#,
                ),
                loopback_peer(),
            ))
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::OK);
        let payload = read_json(ok).await;
        assert_eq!(payload["status"], "installing");

        let status = app
            .oneshot(status_request(Some(&session_token), None))
            .await
            .unwrap();
        assert_eq!(status.status(), StatusCode::OK);
        let payload = read_json(status).await;
        assert_eq!(payload["status"], "installing");
        finish_install(&manager, &helper_dir.0).await;
        assert_eq!(
            fs::read_to_string(helper_dir.0.join("calls")).unwrap(),
            "install\n"
        );
    }

    #[tokio::test]
    async fn concurrent_post_coalesces_one_install() {
        let helper_dir = TempDir::new();
        let manager = write_helper(
            &helper_dir.0,
            r#"printf '%s\n' "$1" >> "$(dirname "$0")/calls"
while [ ! -f "$(dirname "$0")/finish" ]; do sleep 0.02; done
echo '{"status":"error","currentVersion":"1.0.0","version":null,"error":"failed","method":"package"}'
exit 1"#,
        );
        let (state, session_token, _dir) = test_state(Arc::clone(&manager)).await;
        let app = router(state);
        let first = app.clone().oneshot(with_peer(
            install_request(Some(&session_token), Some("http://127.0.0.1:7731"), "{}"),
            loopback_peer(),
        ));
        let second = app.oneshot(with_peer(
            install_request(Some(&session_token), Some("http://127.0.0.1:7731"), "{}"),
            loopback_peer(),
        ));
        let (first, second) = tokio::join!(first, second);
        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(second.status(), StatusCode::OK);
        assert_eq!(read_json(first).await["status"], "installing");
        assert_eq!(read_json(second).await["status"], "installing");
        finish_install(&manager, &helper_dir.0).await;
        assert_eq!(
            fs::read_to_string(helper_dir.0.join("calls")).unwrap(),
            "install\n"
        );
    }

    async fn finish_install(manager: &Arc<PackageUpdateManager>, directory: &Path) {
        fs::write(directory.join("finish"), "").unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while manager.status().await.status == crate::package_update::UpdateStatus::Installing {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("update helper did not finish");
    }
}
