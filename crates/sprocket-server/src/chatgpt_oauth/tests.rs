use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::header;
use sprocket_host::chatgpt_credentials::ChatGptService;

use super::*;
use crate::auth::AuthState;

async fn fixture() -> (tempfile::TempDir, Arc<PendingLogins>, String) {
    let directory = tempfile::tempdir().unwrap();
    let auth = AuthState::load(directory.path()).unwrap();
    let (_, session) = auth.bootstrap_browser_session(true).await.unwrap();
    auth.bind_session_user(&session, "user-a").await.unwrap();
    let service = ChatGptService::load_or_unavailable(directory.path()).unwrap();
    (directory, PendingLogins::new(service, auth), session)
}

async fn pending_attempt(pending: &PendingLogins, session: String) -> String {
    let value = secret();
    pending.logins.lock().await.attempts.insert(
        value.clone(),
        PendingLogin {
            session,
            sign_in: SignIn {
                user: "user-a".into(),
                connection: None,
                redirect_uri: "http://127.0.0.1:1234/auth/callback".into(),
                nonce: secret(),
                verifier: secret(),
            },
            expires: Instant::now() + LOGIN_LIFETIME,
            processing: false,
            result: None,
        },
    );
    value
}

async fn wait_for_failure(pending: &PendingLogins, value: &str) -> String {
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let logins = pending.logins.lock().await;
            if let Some(Err(error)) = &logins.attempts.get(value).unwrap().result {
                return error.clone();
            }
            drop(logins);
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn callback_records_failure_once_without_exposing_oauth_material() {
    let (_directory, pending, session) = fixture().await;
    let value = pending_attempt(&pending, session).await;
    let query = || CallbackQuery {
        state: Some(value.clone()),
        code: None,
        client_id: None,
        error: Some("access_denied".into()),
    };
    let (status, headers, _) = callback(State(Arc::clone(&pending)), Query(query())).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers.contains(&(header::CACHE_CONTROL, "no-store")));
    let (status, _, _) = callback(State(Arc::clone(&pending)), Query(query())).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        wait_for_failure(&pending, &value).await,
        "ChatGPT sign-in was cancelled or failed."
    );
    let logins = pending.logins.lock().await;
    let login = logins.attempts.get(&value).unwrap();
    assert!(login.sign_in.verifier.is_empty());
    assert!(login.sign_in.nonce.is_empty());
    drop(logins);
    assert_eq!(
        serde_json::to_value(LoginResult::Complete).unwrap(),
        serde_json::json!({"status":"complete"})
    );
}

#[tokio::test]
async fn pasted_callback_address_finishes_the_owners_sign_in() {
    let (_directory, pending, session) = fixture().await;
    let value = pending_attempt(&pending, session.clone()).await;
    let address = format!("http://127.0.0.1:1234/auth/callback?state={value}&error=access_denied");
    pending.finish(&session, "user-a", &address).await.unwrap();
    assert_eq!(
        wait_for_failure(&pending, &value).await,
        "ChatGPT sign-in was cancelled or failed."
    );
}

#[tokio::test]
async fn callback_listener_uses_an_available_loopback_port() {
    let (_directory, pending, _) = fixture().await;
    let (redirect_uri, listener) = bind_callback(Arc::clone(&pending)).await.unwrap();
    let url = url::Url::parse(&redirect_uri).unwrap();
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert_eq!(url.path(), "/auth/callback");
    assert!(url.port().unwrap() > 0);
    let response = reqwest::get(redirect_uri).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    listener.abort();
    let _ = listener.await;
}
