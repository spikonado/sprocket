//! One WebSocket per client carries every server-pushed update. Each
//! subscription starts with a snapshot, so a client recovers from a dropped
//! socket by subscribing again.

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
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::AppState;
use crate::auth::{cookie_request_is_csrf_safe, require_bootstrap_session, require_session};
use crate::routes::api_error::ApiError;
use crate::routes::session::UserScoped;
use crate::routes::{agent, artifacts, auth, browser, transcript, workspace};

const PING_INTERVAL: Duration = Duration::from_secs(20);
const AUTH_RECHECK_INTERVAL: Duration = Duration::from_secs(1);
const OUTGOING_CAPACITY: usize = 64;

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
    Transcript(transcript::TranscriptScope),
    LiveCompletion(agent::LiveCompletionWatchRequest),
    Artifacts(artifacts::ArtifactWatchRequest),
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
            Self::LiveCompletion(request) => Some(request.user_id()),
            Self::Artifacts(request) => Some(request.user_id()),
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
    let (outgoing, mut queued) = mpsc::channel::<Message>(OUTGOING_CAPACITY);
    let mut subscriptions = HashMap::<u64, (Topic, JoinHandle<()>)>::new();
    let shutdown = state.host.lifetime.shutdown.clone();
    let mut ping = tokio::time::interval(PING_INTERVAL);
    let mut auth_recheck = tokio::time::interval(AUTH_RECHECK_INTERVAL);
    'serve: loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = ping.tick() => {
                if sink.send(Message::Ping(Default::default())).await.is_err() {
                    break;
                }
            }
            _ = auth_recheck.tick() => {
                for message in revoke_unauthorized(&state, &headers, &mut subscriptions).await {
                    if sink.send(encode(&message)).await.is_err() {
                        break 'serve;
                    }
                }
            }
            Some(message) = queued.recv() => {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
            message = incoming.next() => {
                let Some(Ok(message)) = message else { break };
                let request = match message {
                    Message::Text(text) => serde_json::from_str::<ClientMessage>(text.as_str()),
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok(request) = request else { break };
                match request {
                    ClientMessage::Subscribe { id, topic } => {
                        let task = tokio::spawn(forward(
                            state.clone(),
                            headers.clone(),
                            id,
                            topic.clone(),
                            outgoing.clone(),
                        ));
                        if let Some((_, replaced)) = subscriptions.insert(id, (topic, task)) {
                            replaced.abort();
                        }
                    }
                    ClientMessage::Unsubscribe { id } => {
                        if let Some((_, task)) = subscriptions.remove(&id) {
                            task.abort();
                        }
                    }
                }
            }
        }
    }
    for (_, task) in subscriptions.into_values() {
        task.abort();
    }
}

/// Streams don't see sign-outs, expiry or account switches on their own, so
/// the socket re-checks each subscription. Native sign-outs and account
/// switches unbind local sessions, so in-memory session checks see them too.
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
    revoked
        .into_iter()
        .filter_map(|id| {
            let (_, task) = subscriptions.remove(&id)?;
            task.abort();
            Some(error_message(id, &ApiError::authentication_required()))
        })
        .collect()
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

async fn forward(
    state: AppState,
    headers: HeaderMap,
    id: u64,
    topic: Topic,
    outgoing: mpsc::Sender<Message>,
) {
    let last = match open(&state, &headers, topic).await {
        Ok(mut events) => {
            while let Some(data) = events.next().await {
                if outgoing
                    .send(encode(&ServerMessage::Event { id, data }))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            ServerMessage::End { id }
        }
        Err(error) => error_message(id, &error),
    };
    let _ = outgoing.send(encode(&last)).await;
}

fn error_message(id: u64, error: &ApiError) -> ServerMessage {
    ServerMessage::Error {
        id,
        status: error.status().as_u16(),
        message: error.to_string(),
    }
}

async fn authorize(state: &AppState, headers: &HeaderMap, topic: &Topic) -> Result<(), ApiError> {
    let jar = CookieJar::from_headers(headers);
    if let Some(user_id) = topic.user_id() {
        return state.require_session_user(headers, &jar, user_id).await;
    }
    match topic {
        Topic::AuthChanges => auth::authorize_session_changes(state, headers, &jar).await,
        Topic::BrowserStatus => browser::user(state, headers, &jar).await.map(drop),
        _ => require_session(&state.auth, headers, &jar)
            .await
            .map(drop)
            .map_err(|_| ApiError::authentication_required()),
    }
}

pub(crate) async fn open(
    state: &AppState,
    headers: &HeaderMap,
    topic: Topic,
) -> Result<BoxStream<'static, serde_json::Value>, ApiError> {
    authorize(state, headers, &topic).await?;
    Ok(match topic {
        Topic::Transcript(scope) => json(transcript::watch_events(state, scope).await),
        Topic::LiveCompletion(request) => json(agent::live_events(state, request)),
        Topic::Artifacts(request) => json(artifacts::watch_events(state, request).await?),
        Topic::Commands(request) => json(agent::command_events(state, request)),
        Topic::AuthChanges => json(auth::session_change_events(state)?),
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

fn encode(message: &ServerMessage) -> Message {
    Message::Text(
        serde_json::to_string(message)
            .expect("server messages contain only JSON values and strings")
            .into(),
    )
}

#[cfg(test)]
mod tests;
