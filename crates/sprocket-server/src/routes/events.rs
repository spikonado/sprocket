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
use crate::routes::{agent, artifacts, auth, browser, transcript};

const PING_INTERVAL: Duration = Duration::from_secs(20);
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

#[derive(Deserialize)]
#[serde(tag = "kind", content = "params", rename_all = "camelCase")]
pub(crate) enum Topic {
    Transcript(transcript::TranscriptScope),
    LiveCompletion(agent::LiveCompletionWatchRequest),
    Artifacts(artifacts::ArtifactWatchRequest),
    Commands(agent::CommandsRequest),
    AuthChanges,
    BrowserStatus,
    PackageUpdate,
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
    let mut subscriptions = HashMap::<u64, JoinHandle<()>>::new();
    let shutdown = state.host.lifetime.shutdown.clone();
    let mut ping = tokio::time::interval(PING_INTERVAL);
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = ping.tick() => {
                if sink.send(Message::Ping(Default::default())).await.is_err() {
                    break;
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
                subscriptions.retain(|_, task| !task.is_finished());
                match request {
                    ClientMessage::Subscribe { id, topic } => {
                        let task = tokio::spawn(forward(
                            state.clone(),
                            headers.clone(),
                            id,
                            topic,
                            outgoing.clone(),
                        ));
                        if let Some(replaced) = subscriptions.insert(id, task) {
                            replaced.abort();
                        }
                    }
                    ClientMessage::Unsubscribe { id } => {
                        if let Some(task) = subscriptions.remove(&id) {
                            task.abort();
                        }
                    }
                }
            }
        }
    }
    for task in subscriptions.into_values() {
        task.abort();
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
        Err(error) => ServerMessage::Error {
            id,
            status: error.status().as_u16(),
            message: error.to_string(),
        },
    };
    let _ = outgoing.send(encode(&last)).await;
}

/// Re-checks the socket's session for each subscription, so a sign-out or
/// account switch applies to later subscriptions on an open socket.
pub(crate) async fn open(
    state: &AppState,
    headers: &HeaderMap,
    topic: Topic,
) -> Result<BoxStream<'static, serde_json::Value>, ApiError> {
    let jar = CookieJar::from_headers(headers);
    Ok(match topic {
        Topic::Transcript(scope) => {
            state
                .require_session_user(headers, &jar, scope.user_id())
                .await?;
            json(transcript::watch_events(state, scope).await)
        }
        Topic::LiveCompletion(request) => {
            state
                .require_session_user(headers, &jar, request.user_id())
                .await?;
            json(agent::live_events(state, request))
        }
        Topic::Artifacts(request) => {
            state
                .require_session_user(headers, &jar, request.user_id())
                .await?;
            json(artifacts::watch_events(state, request).await?)
        }
        Topic::Commands(request) => {
            state
                .require_session_user(headers, &jar, request.user_id())
                .await?;
            json(agent::command_events(state, request))
        }
        Topic::AuthChanges => json(auth::session_change_events(state, headers, &jar).await?),
        Topic::BrowserStatus => {
            browser::user(state, headers, &jar).await?;
            json(state.host.browsers.status_events())
        }
        Topic::PackageUpdate => {
            require_session(&state.auth, headers, &jar)
                .await
                .map_err(|_| ApiError::authentication_required())?;
            json(state.host.package_updates.watch())
        }
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
