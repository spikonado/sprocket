use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::Html;
use axum::routing::get;
use serde::Deserialize;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::auth::AuthState;
use crate::chatgpt_credentials::ChatGptService;

const LOGIN_LIFETIME: Duration = Duration::from_secs(5 * 60);

pub(crate) struct PendingLogins {
    logins: Mutex<LoginState>,
    service: Arc<ChatGptService>,
    auth: Arc<AuthState>,
}

impl PendingLogins {
    pub(crate) fn new(service: Arc<ChatGptService>, auth: Arc<AuthState>) -> Arc<Self> {
        Arc::new(Self {
            logins: Mutex::new(LoginState::default()),
            service,
            auth,
        })
    }

    pub(crate) async fn reserve_pending(
        self: &Arc<Self>,
        state: String,
        attempt: PendingAttempt,
    ) -> Result<String, ReserveError> {
        let mut logins = self.logins.lock().await;
        logins
            .attempts
            .retain(|_, login| login.expires > Instant::now());
        if logins
            .listener
            .as_ref()
            .is_some_and(|task| task.is_finished())
        {
            logins.listener.take();
        }
        if logins.listener.is_none() {
            let (redirect_uri, listener) = bind_callback(Arc::clone(self))
                .await
                .map_err(ReserveError::Listener)?;
            logins.redirect_uri = redirect_uri;
            logins.listener = Some(listener);
            logins.generation = logins.generation.wrapping_add(1);
            tokio::spawn(expire_logins(Arc::clone(self), logins.generation));
        }
        if logins
            .attempts
            .values()
            .filter(|login| login.user != attempt.user)
            .count()
            >= 64
        {
            return Err(ReserveError::TooMany);
        }
        let redirect_uri = logins.redirect_uri.clone();
        logins.attempts.insert(state, PendingLogin {
            session: attempt.session,
            user: attempt.user,
            connection: attempt.connection,
            expires: Instant::now() + LOGIN_LIFETIME,
            nonce: attempt.nonce,
            verifier: attempt.verifier,
            redirect_uri: redirect_uri.clone(),
            processing: false,
            result: None,
        });
        Ok(redirect_uri)
    }

    pub(crate) async fn pending_result(
        &self,
        session: &str,
        user: &str,
        state: &str,
    ) -> Option<PendingResult> {
        let logins = self.logins.lock().await;
        let login = logins.attempts.get(state).filter(|login| {
            login.session == session && login.user == user && login.expires > Instant::now()
        })?;
        Some(match &login.result {
            None => PendingResult::Pending,
            Some(Ok(())) => PendingResult::Complete,
            Some(Err(error)) => PendingResult::Error(error.clone()),
        })
    }

    pub(crate) async fn cancel_pending(&self, session: &str, user: &str, state: &str) {
        let mut logins = self.logins.lock().await;
        if logins
            .attempts
            .get(state)
            .is_some_and(|login| login.session == session && login.user == user)
        {
            logins.attempts.remove(state);
            logins.stop_if_idle();
        }
    }

    pub(crate) async fn commit_pending(&self, session: &str, user: &str, state: &str) -> bool {
        let mut logins = self.logins.lock().await;
        let valid = logins.attempts.get(state).is_some_and(|login| {
            login.session == session && login.user == user && login.expires > Instant::now()
        });
        if !valid {
            return false;
        }
        logins
            .attempts
            .retain(|key, login| login.user != user || key == state);
        true
    }

    pub(crate) async fn drop_user_pending(&self, user: &str) {
        let mut logins = self.logins.lock().await;
        logins.attempts.retain(|_, login| login.user != user);
        logins.stop_if_idle();
    }
}

#[derive(Default)]
struct LoginState {
    attempts: HashMap<String, PendingLogin>,
    listener: Option<tokio::task::JoinHandle<std::io::Result<()>>>,
    redirect_uri: String,
    generation: u64,
}

impl LoginState {
    fn stop_if_idle(&mut self) {
        if self.attempts.is_empty()
            && let Some(task) = self.listener.take()
        {
            task.abort();
        }
    }
}

#[derive(Clone)]
struct PendingLogin {
    session: String,
    user: String,
    connection: Option<String>,
    expires: Instant,
    nonce: String,
    verifier: String,
    redirect_uri: String,
    processing: bool,
    result: Option<Result<(), String>>,
}

pub(crate) struct PendingAttempt {
    pub session: String,
    pub user: String,
    pub connection: Option<String>,
    pub nonce: String,
    pub verifier: String,
}

pub(crate) enum ReserveError {
    Listener(std::io::Error),
    TooMany,
}

pub(crate) enum PendingResult {
    Pending,
    Complete,
    Error(String),
}

#[derive(Deserialize)]
struct CallbackQuery {
    state: Option<String>,
    code: Option<String>,
    client_id: Option<String>,
    error: Option<String>,
}

pub(crate) fn new_secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

pub(crate) async fn shutdown(pending: &PendingLogins) {
    let mut logins = pending.logins.lock().await;
    logins.attempts.clear();
    logins.stop_if_idle();
}

async fn bind_callback(
    pending: Arc<PendingLogins>,
) -> std::io::Result<(String, tokio::task::JoinHandle<std::io::Result<()>>)> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let redirect_uri = format!(
        "http://127.0.0.1:{}/auth/callback",
        listener.local_addr()?.port()
    );
    let router = axum::Router::new()
        .route("/auth/callback", get(callback))
        .with_state(pending);
    Ok((
        redirect_uri,
        tokio::spawn(axum::serve(listener, router).into_future()),
    ))
}

async fn expire_logins(pending: Arc<PendingLogins>, generation: u64) {
    loop {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let mut logins = pending.logins.lock().await;
        if logins.generation != generation {
            return;
        }
        logins
            .attempts
            .retain(|_, login| login.expires > Instant::now());
        if logins.attempts.is_empty() {
            logins.stop_if_idle();
            return;
        }
    }
}

async fn finish_callback(
    pending: Arc<PendingLogins>,
    state: String,
    login: PendingLogin,
    query: CallbackQuery,
) {
    let outcome = match (query.code, query.error) {
        (Some(code), None) if !code.is_empty() && code.len() <= 4096 => {
            pending
                .service
                .exchange(
                    &login.user,
                    login.connection.as_deref(),
                    &login.redirect_uri,
                    &login.nonce,
                    &login.verifier,
                    &code,
                    query.client_id.as_deref(),
                )
                .await
        }
        _ => Err(anyhow::anyhow!("ChatGPT sign-in was cancelled or failed.")),
    };
    let mut logins = pending.logins.lock().await;
    let session_guard = pending
        .auth
        .lock_session_user(&login.session, &login.user)
        .await;
    let valid = logins.attempts.get(&state).is_some_and(|current| {
        current.session == login.session
            && current.user == login.user
            && current.expires > Instant::now()
    }) && session_guard.is_ok();
    if !valid {
        drop(session_guard);
        drop(logins);
        if let Ok(grant) = outcome {
            pending.service.discard(grant).await;
        }
        return;
    }
    let result = match outcome {
        Ok(grant) => pending.service.commit(&login.user, grant).await,
        Err(error) => Err(error),
    };
    drop(session_guard);
    if let Some(current) = logins.attempts.get_mut(&state) {
        current.result = Some(result.map_err(|error| error.to_string()));
        current.verifier.clear();
        current.nonce.clear();
    }
}

async fn callback(
    State(pending): State<Arc<PendingLogins>>,
    Query(query): Query<CallbackQuery>,
) -> (
    StatusCode,
    [(header::HeaderName, &'static str); 2],
    Html<&'static str>,
) {
    let headers = [
        (header::CACHE_CONTROL, "no-store"),
        (header::REFERRER_POLICY, "no-referrer"),
    ];
    let Some(state) = query.state.clone() else {
        return (
            StatusCode::BAD_REQUEST,
            headers,
            Html("Invalid ChatGPT sign-in."),
        );
    };
    let mut logins = pending.logins.lock().await;
    let Some(login) = logins.attempts.get_mut(&state) else {
        return (
            StatusCode::BAD_REQUEST,
            headers,
            Html("ChatGPT sign-in expired or was cancelled."),
        );
    };
    if login.expires <= Instant::now() || login.processing || login.result.is_some() {
        return (
            StatusCode::BAD_REQUEST,
            headers,
            Html("ChatGPT sign-in expired or was already completed."),
        );
    }
    login.processing = true;
    let login = login.clone();
    drop(logins);
    tokio::spawn(finish_callback(pending, state, login, query));
    (
        StatusCode::OK,
        headers,
        Html("ChatGPT sign-in received. Return to Sprocket to check the connection."),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use axum::extract::{Query, State};
    use axum::http::{StatusCode, header};

    use super::*;
    use crate::AppState;
    use crate::auth::AuthState;

    async fn fixture() -> (tempfile::TempDir, AppState, String) {
        let directory = tempfile::tempdir().unwrap();
        let auth = AuthState::load(directory.path()).unwrap();
        let (_, session) = auth.bootstrap_browser_session(true).await.unwrap();
        auth.bind_session_user(&session, "user-a").await.unwrap();
        let native_auth = crate::native_auth::NativeAuthManager::new(
            "https://example.convex.cloud".into(),
            "http://127.0.0.1:7731/auth/callback".into(),
            directory.path(),
            Arc::clone(&auth),
        );
        let state = AppState::for_test(
            auth,
            native_auth,
            directory.path().to_owned(),
            true,
            crate::package_update::PackageUpdateManager::from_env(),
        );
        (directory, state, session)
    }

    #[tokio::test]
    async fn callback_records_failure_once_without_exposing_oauth_material() {
        let (_directory, state, session) = fixture().await;
        let pending = state.chatgpt_oauth;
        let value = new_secret();
        pending
            .logins
            .lock()
            .await
            .attempts
            .insert(value.clone(), PendingLogin {
                session,
                user: "user-a".into(),
                connection: None,
                expires: Instant::now() + LOGIN_LIFETIME,
                nonce: new_secret(),
                verifier: new_secret(),
                redirect_uri: "http://127.0.0.1:1234/auth/callback".into(),
                processing: false,
                result: None,
            });
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
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let logins = pending.logins.lock().await;
                let login = logins.attempts.get(&value).unwrap();
                if let Some(Err(error)) = &login.result {
                    assert_eq!(error, "ChatGPT sign-in was cancelled or failed.");
                    assert!(login.verifier.is_empty());
                    assert!(login.nonce.is_empty());
                    break;
                }
                drop(logins);
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn callback_listener_uses_an_available_loopback_port() {
        let (_directory, state, _) = fixture().await;
        let (redirect_uri, listener) = bind_callback(Arc::clone(&state.chatgpt_oauth))
            .await
            .unwrap();
        let url = url::Url::parse(&redirect_uri).unwrap();
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert_eq!(url.path(), "/auth/callback");
        assert!(url.port().unwrap() > 0);
        let response = reqwest::get(redirect_uri).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        listener.abort();
        let _ = listener.await;
    }
}
