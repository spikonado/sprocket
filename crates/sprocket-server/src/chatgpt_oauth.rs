use std::collections::HashMap;
use std::future::IntoFuture;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::Html;
use axum::routing::get;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::auth::AuthState;
use sprocket_host::chatgpt_credentials::ChatGptService;

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

    pub(crate) async fn start(
        self: &Arc<Self>,
        session: String,
        user: String,
        connection: Option<String>,
    ) -> Result<StartedLogin, StartError> {
        let value = secret();
        let nonce = secret();
        let verifier = secret();
        let mut logins = self.logins.lock().await;
        logins.expire();
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
                .map_err(|_| StartError::Listener)?;
            logins.redirect_uri = redirect_uri;
            logins.listener = Some(listener);
            logins.generation = logins.generation.wrapping_add(1);
            tokio::spawn(expire_logins(Arc::clone(self), logins.generation));
        }
        let redirect_uri = logins.redirect_uri.clone();
        let authorize_url = self
            .service
            .authorization(
                &user,
                connection.as_deref(),
                &redirect_uri,
                &value,
                &nonce,
                &verifier,
            )
            .await
            .map_err(StartError::Failed)?;
        logins.attempts.retain(|_, login| login.user != user);
        if logins.attempts.len() >= 64 {
            return Err(StartError::Failed(anyhow::anyhow!(
                "Too many pending sign-ins. Retry later."
            )));
        }
        logins.attempts.insert(value.clone(), PendingLogin {
            session,
            user,
            connection,
            expires: Instant::now() + LOGIN_LIFETIME,
            nonce,
            verifier,
            redirect_uri,
            processing: false,
            result: None,
        });
        Ok(StartedLogin {
            state: value,
            authorize_url,
        })
    }

    pub(crate) async fn poll(&self, session: &str, user: &str, state: &str) -> Option<LoginResult> {
        let logins = self.logins.lock().await;
        let login = logins.attempts.get(state).filter(|login| {
            login.session == session && login.user == user && login.expires > Instant::now()
        })?;
        Some(match &login.result {
            None => LoginResult::Pending,
            Some(Ok(())) => LoginResult::Complete,
            Some(Err(error)) => LoginResult::Error {
                error: error.clone(),
            },
        })
    }

    pub(crate) async fn cancel(&self, session: &str, user: &str, state: &str) {
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

    pub(crate) async fn forget_user(&self, user: &str) {
        let mut logins = self.logins.lock().await;
        logins.attempts.retain(|_, login| login.user != user);
        logins.stop_if_idle();
    }

    pub(crate) async fn shutdown(&self) {
        let mut logins = self.logins.lock().await;
        logins.attempts.clear();
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
    fn expire(&mut self) {
        self.attempts
            .retain(|_, login| login.expires > Instant::now());
    }

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartedLogin {
    state: String,
    authorize_url: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum LoginResult {
    Pending,
    Complete,
    Error { error: String },
}

pub(crate) enum StartError {
    Listener,
    Failed(anyhow::Error),
}

#[derive(Deserialize)]
struct CallbackQuery {
    state: Option<String>,
    code: Option<String>,
    client_id: Option<String>,
    error: Option<String>,
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
        logins.expire();
        if logins.attempts.is_empty() {
            logins.stop_if_idle();
            return;
        }
    }
}

fn secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
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
mod tests;
