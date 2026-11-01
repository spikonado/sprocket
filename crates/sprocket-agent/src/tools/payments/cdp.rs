use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Duration;

use anyhow::{Context, anyhow};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::{Error as SocketError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use super::{ProcessorResponse, Recognizer, fulfilled_headers, recognize};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

/// A processor request held paused in the browser until its purchase resolves.
pub(super) struct PausedPayment {
    session_id: String,
    request_id: String,
    pub(super) psp: String,
    pub(super) request: PausedRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PausedRequest {
    url: String,
    method: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    post_data: Option<String>,
    #[serde(default)]
    post_data_entries: Vec<PostDataEntry>,
}

#[derive(Deserialize)]
struct PostDataEntry {
    bytes: Option<String>,
}

impl PausedRequest {
    pub(super) fn to_convex(&self) -> Value {
        let mut request =
            json!({ "url": self.url, "method": self.method, "headers": self.headers });
        if let Some(body) = self.body() {
            request["body"] = body.into();
        }
        request
    }

    fn body(&self) -> Option<String> {
        let mut bytes = Vec::new();
        for entry in &self.post_data_entries {
            match entry
                .bytes
                .as_deref()
                .map(|encoded| STANDARD.decode(encoded))
            {
                Some(Ok(decoded)) => bytes.extend(decoded),
                _ => return self.post_data.clone(),
            }
        }
        if bytes.is_empty() {
            self.post_data.clone()
        } else {
            Some(String::from_utf8_lossy(&bytes).into_owned())
        }
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

enum Command {
    Call {
        method: &'static str,
        params: Value,
        session_id: Option<String>,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    /// Answered once every frame attached so far intercepts requests.
    Settle(oneshot::Sender<()>),
    Close,
}

/// Holds a browser-level CDP connection that pauses every request in one tab
/// and its cross-origin frames, keeps the first recognized payment request,
/// and continues everything else. Closing the connection detaches every
/// session, which releases anything still paused.
pub(super) struct Interceptor {
    commands: mpsc::UnboundedSender<Command>,
    payment: oneshot::Receiver<PausedPayment>,
    target_id: String,
    task: JoinHandle<()>,
}

impl Interceptor {
    pub(super) async fn arm(
        cdp_url: &str,
        target_id: String,
        recognizers: Vec<Recognizer>,
    ) -> anyhow::Result<Self> {
        let (socket, _) = tokio_tungstenite::connect_async(cdp_url)
            .await
            .context("connect to the browser over CDP")?;
        let (commands, receiver) = mpsc::unbounded_channel();
        let (payment_sender, payment) = oneshot::channel();
        let pump = Pump {
            socket,
            recognizers,
            next_id: 0,
            replies: HashMap::new(),
            arming: HashSet::new(),
            settle_waiters: Vec::new(),
            payment: Some(payment_sender),
        };
        let interceptor = Self {
            commands,
            payment,
            target_id,
            task: tokio::spawn(pump.run(receiver)),
        };
        let attached = interceptor
            .call(
                "Target.attachToTarget",
                json!({ "targetId": interceptor.target_id, "flatten": true }),
                None,
            )
            .await?;
        let session_id = attached
            .get("sessionId")
            .and_then(Value::as_str)
            .context("Target.attachToTarget returned no sessionId")?;
        interceptor
            .call("Fetch.enable", fetch_params(), Some(session_id))
            .await?;
        interceptor
            .call(
                "Target.setAutoAttach",
                auto_attach_params(),
                Some(session_id),
            )
            .await?;
        let (settled, wait) = oneshot::channel();
        interceptor.send(Command::Settle(settled))?;
        tokio::time::timeout(COMMAND_TIMEOUT, wait)
            .await
            .context("timed out intercepting the checkout's frames")?
            .context("browser connection closed")?;
        Ok(interceptor)
    }

    /// Resolves with the first recognized payment request.
    pub(super) async fn payment(&mut self) -> anyhow::Result<PausedPayment> {
        (&mut self.payment)
            .await
            .context("browser connection closed before the payment request")
    }

    pub(super) async fn closed(&self) {
        self.commands.closed().await;
    }

    pub(super) async fn page_url(&self) -> anyhow::Result<String> {
        let info = self
            .call(
                "Target.getTargetInfo",
                json!({ "targetId": self.target_id }),
                None,
            )
            .await?;
        info.pointer("/targetInfo/url")
            .and_then(Value::as_str)
            .map(str::to_string)
            .context("Target.getTargetInfo returned no url")
    }

    pub(super) async fn fulfill(
        &self,
        payment: &PausedPayment,
        response: &ProcessorResponse,
    ) -> anyhow::Result<()> {
        let headers: Vec<_> =
            fulfilled_headers(&response.headers, payment.request.header("origin"))
                .into_iter()
                .map(|(name, value)| json!({ "name": name, "value": value }))
                .collect();
        self.call(
            "Fetch.fulfillRequest",
            json!({
                "requestId": payment.request_id,
                "responseCode": response.status,
                "responseHeaders": headers,
                "body": STANDARD.encode(&response.body),
            }),
            Some(&payment.session_id),
        )
        .await
        .map(drop)
    }

    /// Fails the paused request so the placeholder card never reaches the processor.
    pub(super) async fn fail(&self, payment: &PausedPayment) {
        let _ = self
            .call(
                "Fetch.failRequest",
                json!({ "requestId": payment.request_id, "errorReason": "Failed" }),
                Some(&payment.session_id),
            )
            .await;
    }

    pub(super) async fn close(mut self) {
        let _ = self.commands.send(Command::Close);
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, &mut self.task).await;
    }

    async fn call(
        &self,
        method: &'static str,
        params: Value,
        session_id: Option<&str>,
    ) -> anyhow::Result<Value> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Call {
            method,
            params,
            session_id: session_id.map(str::to_string),
            reply,
        })?;
        tokio::time::timeout(COMMAND_TIMEOUT, response)
            .await
            .with_context(|| format!("{method} timed out"))?
            .context("browser connection closed")?
            .map_err(|error| anyhow!("{method} failed: {error}"))
    }

    fn send(&self, command: Command) -> anyhow::Result<()> {
        self.commands
            .send(command)
            .map_err(|_| anyhow!("browser connection closed"))
    }
}

impl Drop for Interceptor {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn fetch_params() -> Value {
    json!({ "patterns": [{ "urlPattern": "*", "requestStage": "Request" }] })
}

/// Payment card fields load in cross-origin iframes, which are their own
/// targets. New ones wait until they intercept requests too.
fn auto_attach_params() -> Value {
    json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true })
}

struct Pump {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    recognizers: Vec<Recognizer>,
    next_id: u64,
    replies: HashMap<u64, oneshot::Sender<Result<Value, String>>>,
    /// Commands that arm attached frames, so `Settle` knows when they're done.
    arming: HashSet<u64>,
    settle_waiters: Vec<oneshot::Sender<()>>,
    payment: Option<oneshot::Sender<PausedPayment>>,
}

enum Input {
    Socket(Option<Result<Message, SocketError>>),
    Command(Option<Command>),
}

impl Pump {
    async fn run(mut self, mut commands: mpsc::UnboundedReceiver<Command>) {
        loop {
            let input = tokio::select! {
                message = self.socket.next() => Input::Socket(message),
                command = commands.recv() => Input::Command(command),
            };
            let handled = match input {
                Input::Socket(Some(Ok(Message::Text(text)))) => self.receive(text.as_str()).await,
                Input::Socket(Some(Ok(Message::Close(_)) | Err(_)) | None) => break,
                Input::Socket(Some(Ok(_))) => Ok(()),
                Input::Command(Some(Command::Call {
                    method,
                    params,
                    session_id,
                    reply,
                })) => self
                    .send(method, params, session_id.as_deref())
                    .await
                    .map(|id| {
                        self.replies.insert(id, reply);
                    }),
                Input::Command(Some(Command::Settle(waiter))) => {
                    self.settle_waiters.push(waiter);
                    self.release_settled();
                    Ok(())
                }
                Input::Command(Some(Command::Close) | None) => break,
            };
            if handled.is_err() {
                break;
            }
        }
        let _ = self.socket.close(None).await;
    }

    async fn send(
        &mut self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<u64, SocketError> {
        self.next_id += 1;
        let id = self.next_id;
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session_id) = session_id {
            message["sessionId"] = session_id.into();
        }
        self.socket.send(Message::text(message.to_string())).await?;
        Ok(id)
    }

    async fn receive(&mut self, text: &str) -> Result<(), SocketError> {
        let Ok(message) = serde_json::from_str::<Value>(text) else {
            return Ok(());
        };
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            if let Some(reply) = self.replies.remove(&id) {
                let _ = reply.send(match message.get("error") {
                    Some(error) => Err(error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("CDP error")
                        .to_string()),
                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                });
            }
            if self.arming.remove(&id) {
                // Frames that detach while arming fail here; they can't send payments.
                if let Some(error) = message.pointer("/error/message").and_then(Value::as_str) {
                    eprintln!("sprocket-agent: could not intercept a checkout frame: {error}");
                }
                self.release_settled();
            }
            return Ok(());
        }
        // Events without a session come from the browser target, not the tab.
        let Some(session_id) = message.get("sessionId").and_then(Value::as_str) else {
            return Ok(());
        };
        match message.get("method").and_then(Value::as_str) {
            Some("Target.attachedToTarget") => {
                if let Some(child) = message.pointer("/params/sessionId").and_then(Value::as_str) {
                    self.arm_child(child).await?;
                }
            }
            Some("Fetch.requestPaused") => {
                if let Some(params) = message.get("params") {
                    self.paused(session_id, params).await?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Commands on one session run in order, so the frame intercepts requests
    /// before it resumes.
    async fn arm_child(&mut self, session_id: &str) -> Result<(), SocketError> {
        let fetch = self
            .send("Fetch.enable", fetch_params(), Some(session_id))
            .await?;
        let attach = self
            .send(
                "Target.setAutoAttach",
                auto_attach_params(),
                Some(session_id),
            )
            .await?;
        self.arming.extend([fetch, attach]);
        self.send(
            "Runtime.runIfWaitingForDebugger",
            json!({}),
            Some(session_id),
        )
        .await?;
        Ok(())
    }

    async fn paused(&mut self, session_id: &str, params: &Value) -> Result<(), SocketError> {
        let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
            return Ok(());
        };
        if let Some(payment) = self.recognized(session_id, request_id, params)
            && let Some(sender) = self.payment.take()
            && sender.send(payment).is_ok()
        {
            return Ok(());
        }
        self.send(
            "Fetch.continueRequest",
            json!({ "requestId": request_id }),
            Some(session_id),
        )
        .await
        .map(drop)
    }

    fn recognized(
        &self,
        session_id: &str,
        request_id: &str,
        params: &Value,
    ) -> Option<PausedPayment> {
        self.payment.as_ref()?;
        let method = params.pointer("/request/method")?.as_str()?;
        // CORS preflights go to the same endpoint and must reach the processor.
        if method.eq_ignore_ascii_case("OPTIONS") {
            return None;
        }
        let psp = recognize(&self.recognizers, params.pointer("/request/url")?.as_str()?)?;
        Some(PausedPayment {
            session_id: session_id.to_string(),
            request_id: request_id.to_string(),
            psp: psp.to_string(),
            request: serde_json::from_value(params.get("request")?.clone()).ok()?,
        })
    }

    fn release_settled(&mut self) {
        if self.arming.is_empty() {
            for waiter in self.settle_waiters.drain(..) {
                let _ = waiter.send(());
            }
        }
    }
}
