use std::sync::Mutex;

use super::*;

/// Refuses every Go request the way OpenCode answers a key without a Go subscription.
#[derive(Clone, Default)]
struct GoRefuses(Arc<Mutex<Vec<(String, String)>>>);

impl HttpClientExt for GoRefuses {
    fn send<T, U>(
        &self,
        _req: Request<T>,
    ) -> impl Future<Output = http_client::Result<Response<LazyBody<U>>>> + WasmCompatSend + 'static
    where
        T: Into<Bytes>,
        T: WasmCompatSend,
        U: From<Bytes>,
        U: WasmCompatSend + 'static,
    {
        std::future::ready(Err(http_client::Error::StreamEnded))
    }

    fn send_multipart<U>(
        &self,
        _req: Request<MultipartForm>,
    ) -> impl Future<Output = http_client::Result<Response<LazyBody<U>>>> + WasmCompatSend + 'static
    where
        U: From<Bytes>,
        U: WasmCompatSend + 'static,
    {
        std::future::ready(Err(http_client::Error::StreamEnded))
    }

    fn send_streaming<T>(
        &self,
        req: Request<T>,
    ) -> impl Future<Output = http_client::Result<StreamingResponse>> + WasmCompatSend
    where
        T: Into<Bytes> + WasmCompatSend,
    {
        let uri = req.uri().to_string();
        let session = req.headers()[SESSION_HEADER].to_str().unwrap().to_string();
        self.0.lock().unwrap().push((uri.clone(), session));
        std::future::ready(if uri.starts_with(GO_URL) {
            Err(http_client::Error::non_success_with_details(
                StatusCode::FORBIDDEN,
                http::HeaderMap::new(),
                String::new(),
            ))
        } else {
            let body: http_client::BoxedStream = Box::pin(futures::stream::empty());
            Ok(Response::new(body))
        })
    }
}

#[tokio::test]
async fn requests_stay_on_pay_as_you_go_once_go_refuses_one() {
    let inner = GoRefuses::default();
    let transport = PlanFallback {
        inner: DynHttpClient::new(inner.clone()),
        session: HeaderValue::from_static("thread-1"),
        pay_as_you_go: Arc::default(),
    };
    for _ in 0..2 {
        let request = Request::post(format!("{GO_URL}/openai/v1/responses"))
            .body(Bytes::new())
            .unwrap();
        transport.send_streaming(request).await.unwrap();
    }
    let go = format!("{GO_URL}/openai/v1/responses");
    let pay_as_you_go = format!("{PAY_AS_YOU_GO_URL}/openai/v1/responses");
    let sent: Vec<(String, String)> = [go, pay_as_you_go.clone(), pay_as_you_go]
        .into_iter()
        .map(|uri| (uri, "thread-1".to_string()))
        .collect();
    assert_eq!(*inner.0.lock().unwrap(), sent);
}

#[test]
fn open_models_use_go_chat_completions_with_instructions_first() {
    let wire = InstructedChat {
        wire: OpenAIConfig::with_key(&OPENCODE_GO, "key").chat("deepseek-v4.1-flash"),
        instructions: "Be brief.".to_string(),
    };
    let encoded = wire
        .encode(CompletionRequest::new("next"), Mode::Streaming)
        .unwrap();
    assert_eq!(
        encoded.request.uri().to_string(),
        format!("{GO_URL}/openai/v1/chat/completions")
    );
    let rig::wire::Body::Bytes(bytes) = encoded.request.into_body() else {
        panic!("Chat Completions uses JSON");
    };
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        body["messages"][0],
        serde_json::json!({"role": "system", "content": "Be brief."})
    );
}
