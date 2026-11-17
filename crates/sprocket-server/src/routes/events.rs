use std::collections::HashMap;
use std::time::Duration;

use anyhow::anyhow;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum_extra::extract::CookieJar;
use futures::stream::BoxStream;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

use crate::AppState;
use crate::auth::{cookie_request_is_csrf_safe, require_bootstrap_session, require_session};
use crate::routes::api_error::ApiError;
use crate::routes::session::UserScoped;
use crate::routes::{agent, artifacts, auth, browser, transcript_rows, workspace};

const PING_INTERVAL: Duration = Duration::from_secs(20);
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(40);
const AUTH_RECHECK_INTERVAL: Duration = Duration::from_secs(1);

mod pending;
use pending::Outgoing;

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new().route("/events", get(upgrade))
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMessage {
    Subscribe { id: u64, topic: Topic },
    Unsubscribe { id: u64 },
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", content = "params", rename_all = "camelCase")]
pub(crate) enum Topic {
    Transcript(transcript_rows::TranscriptRowsScope),
    TranscriptWork(transcript_rows::TranscriptRowScope),
    TranscriptItem(transcript_rows::TranscriptRowScope),
    ArtifactSync(artifacts::ArtifactWatchRequest),
    Commands(agent::CommandsRequest),
    AuthChanges,
    BrowserStatus,
    PackageUpdate,
    WorkspaceFiles(workspace::WorkspaceFilesWatchRequest),
    WorkspaceFile(workspace::WorkspaceEntryRequest),
}

impl Topic {
    fn user_id(&self) -> Option<&str> {
        match self {
            Self::Transcript(scope) => Some(scope.user_id()),
            Self::TranscriptWork(scope) | Self::TranscriptItem(scope) => Some(scope.user_id()),
            Self::ArtifactSync(request) => Some(request.user_id()),
            Self::Commands(request) => Some(request.user_id()),
            Self::AuthChanges
            | Self::BrowserStatus
            | Self::PackageUpdate
            | Self::WorkspaceFiles(_)
            | Self::WorkspaceFile(_) => None,
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerMessage {
    Event {
        id: u64,
        data: serde_json::Value,
    },
    Error {
        id: u64,
        status: u16,
        message: String,
    },
    End {
        id: u64,
    },
}

impl ServerMessage {
    fn id(&self) -> u64 {
        match self {
            Self::Event { id, .. } | Self::Error { id, .. } | Self::End { id } => *id,
        }
    }
}

async fn upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    websocket: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    // Browsers skip CORS for WebSockets, so a cross-site page could otherwise
    // open one with the session cookie.
    if !cookie_request_is_csrf_safe(&headers) {
        return Err(ApiError::with_status(
            StatusCode::FORBIDDEN,
            anyhow!("live updates require a same-origin request"),
        ));
    }
    require_bootstrap_session(&state.auth, &headers, &CookieJar::from_headers(&headers))
        .await
        .map_err(ApiError::unauthorized)?;
    Ok(websocket.on_upgrade(move |socket| serve(state, headers, socket)))
}

async fn serve(state: AppState, headers: HeaderMap, socket: WebSocket) {
    let (mut sink, mut incoming) = socket.split();
    let outgoing = Outgoing::default();
    let queued = outgoing.clone();
    let connection_closed = tokio_util::sync::CancellationToken::new();
    let sender_closed = connection_closed.clone();
    let sender = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING_INTERVAL);
        loop {
            let (deadline, message) = tokio::select! {
                _ = sender_closed.cancelled() => break,
                _ = ping.tick() => (
                    tokio::time::Instant::now() + CONNECTION_TIMEOUT,
                    Message::Ping(Default::default()),
                ),
                (since, messages) = queued.next() => (
                    since + CONNECTION_TIMEOUT,
                    encode(&messages),
                ),
            };
            if !matches!(
                tokio::time::timeout_at(deadline, sink.send(message)).await,
                Ok(Ok(()))
            ) {
                break;
            }
        }
        sender_closed.cancel();
    });
    let mut subscriptions = HashMap::<u64, (Topic, JoinHandle<()>)>::new();
    let shutdown = state.host.lifetime.shutdown.clone();
    let mut last_pong = tokio::time::Instant::now();
    let mut auth_recheck = tokio::time::interval(AUTH_RECHECK_INTERVAL);
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = connection_closed.cancelled() => break,
            _ = auth_recheck.tick() => {
                if last_pong.elapsed() >= CONNECTION_TIMEOUT {
                    break;
                }
                for message in revoke_unauthorized(&state, &headers, &mut subscriptions).await {
                    outgoing.remove(message.id());
                    outgoing.send(message);
                }
            }
            message = incoming.next() => {
                let Some(Ok(message)) = message else { break };
                let request = match message {
                    Message::Text(text) => serde_json::from_str::<ClientMessage>(text.as_str()),
                    Message::Close(_) => break,
                    Message::Pong(_) => {
                        last_pong = tokio::time::Instant::now();
                        continue;
                    }
                    _ => continue,
                };
                let Ok(request) = request else { break };
                match request {
                    ClientMessage::Subscribe { id, topic } => {
                        if let Some((_, replaced)) = subscriptions.remove(&id) {
                            replaced.abort();
                            let _ = replaced.await;
                        }
                        outgoing.remove(id);
                        let task = tokio::spawn(forward(
                            state.clone(),
                            headers.clone(),
                            id,
                            topic.clone(),
                            outgoing.clone(),
                        ));
                        subscriptions.insert(id, (topic, task));
                    }
                    ClientMessage::Unsubscribe { id } => {
                        if let Some((_, task)) = subscriptions.remove(&id) {
                            task.abort();
                            let _ = task.await;
                        }
                        outgoing.remove(id);
                    }
                }
            }
        }
    }
    connection_closed.cancel();
    sender.abort();
    for (_, task) in subscriptions.into_values() {
        task.abort();
    }
}

async fn revoke_unauthorized(
    state: &AppState,
    headers: &HeaderMap,
    subscriptions: &mut HashMap<u64, (Topic, JoinHandle<()>)>,
) -> Vec<ServerMessage> {
    subscriptions.retain(|_, (_, task)| !task.is_finished());
    let mut revoked = Vec::new();
    for (id, (topic, _)) in subscriptions.iter() {
        if !session_still_allows(state, headers, topic).await {
            revoked.push(*id);
        }
    }
    let mut messages = Vec::new();
    for id in revoked {
        if let Some((_, task)) = subscriptions.remove(&id) {
            task.abort();
            let _ = task.await;
            messages.push(error_message(id, &ApiError::authentication_required()));
        }
    }
    messages
}

async fn session_still_allows(state: &AppState, headers: &HeaderMap, topic: &Topic) -> bool {
    let jar = CookieJar::from_headers(headers);
    if let Some(user_id) = topic.user_id() {
        return crate::auth::require_session_user(&state.auth, headers, &jar, user_id)
            .await
            .is_ok();
    }
    match topic {
        Topic::AuthChanges => auth::authorize_session_changes(state, headers, &jar)
            .await
            .is_ok(),
        _ => match require_session(&state.auth, headers, &jar).await {
            Ok(token) => {
                !matches!(topic, Topic::BrowserStatus) || state.auth.session_has_user(&token).await
            }
            Err(_) => false,
        },
    }
}

async fn forward(state: AppState, headers: HeaderMap, id: u64, topic: Topic, outgoing: Outgoing) {
    let last = match open(&state, &headers, topic).await {
        Ok(mut events) => {
            while let Some(data) = events.next().await {
                outgoing.send(ServerMessage::Event { id, data });
            }
            ServerMessage::End { id }
        }
        Err(error) => error_message(id, &error),
    };
    outgoing.send(last);
}

fn error_message(id: u64, error: &ApiError) -> ServerMessage {
    ServerMessage::Error {
        id,
        status: error.status().as_u16(),
        message: error.to_string(),
    }
}

pub(crate) struct Authorized<T>(T);

impl<T> Authorized<T> {
    pub(crate) fn into_inner(self) -> T {
        self.0
    }

    #[cfg(test)]
    pub(crate) fn assume(value: T) -> Self {
        Self(value)
    }
}

async fn authorize(
    state: &AppState,
    headers: &HeaderMap,
    topic: Topic,
) -> Result<Authorized<Topic>, ApiError> {
    let jar = CookieJar::from_headers(headers);
    if let Some(user_id) = topic.user_id() {
        state.require_session_user(headers, &jar, user_id).await?;
        return Ok(Authorized(topic));
    }
    match &topic {
        Topic::AuthChanges => auth::authorize_session_changes(state, headers, &jar).await,
        Topic::BrowserStatus => browser::user(state, headers, &jar).await.map(drop),
        _ => require_session(&state.auth, headers, &jar)
            .await
            .map(drop)
            .map_err(|_| ApiError::authentication_required()),
    }?;
    Ok(Authorized(topic))
}

pub(crate) async fn open(
    state: &AppState,
    headers: &HeaderMap,
    topic: Topic,
) -> Result<BoxStream<'static, serde_json::Value>, ApiError> {
    let Authorized(topic) = authorize(state, headers, topic).await?;
    Ok(match topic {
        Topic::Transcript(scope) => json(transcript_rows::watch_rows(state, Authorized(scope))),
        Topic::TranscriptWork(scope) => json(transcript_rows::watch_work(state, Authorized(scope))),
        Topic::TranscriptItem(scope) => json(transcript_rows::watch_item(state, Authorized(scope))),
        Topic::ArtifactSync(request) => artifacts::watch_events(state, Authorized(request))
            .await?
            .map(|_| serde_json::Value::Null)
            .boxed(),
        Topic::Commands(request) => json(agent::command_events(state, Authorized(request))),
        Topic::AuthChanges => json(auth::session_change_events(state, Authorized(()))?),
        Topic::BrowserStatus => json(state.host.browsers.status_events()),
        Topic::PackageUpdate => json(state.host.package_updates.watch()),
        Topic::WorkspaceFiles(request) => json(workspace::file_list_events(state, request)),
        Topic::WorkspaceFile(request) => json(workspace::file_events(request)),
    })
}

fn json<T: Serialize + Send + 'static>(
    events: BoxStream<'static, T>,
) -> BoxStream<'static, serde_json::Value> {
    events
        .filter_map(|event| futures::future::ready(serde_json::to_value(event).ok()))
        .boxed()
}

fn encode(messages: &[ServerMessage]) -> Message {
    #[derive(Serialize)]
    #[serde(tag = "type", rename = "batch")]
    struct Batch<'a> {
        messages: &'a [ServerMessage],
    }

    Message::Text(
        serde_json::to_string(&Batch { messages })
            .expect("server messages contain only JSON values and strings")
            .into(),
    )
}

#[cfg(test)]
mod tests;
