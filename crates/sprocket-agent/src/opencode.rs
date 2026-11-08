use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use bytes::Bytes;
use rig::http_client::{
    self, DynHttpClient, HeaderValue, HttpClientExt, LazyBody, MultipartForm, Request, Response,
    StatusCode, StreamingResponse,
};
use rig::operation::Completion;
use rig::providers::anthropic::AnthropicConfig;
use rig::providers::openai::OpenAIConfig;
use rig::providers::openai::responses_api::wire::Responses;
use rig::wasm_compat::WasmCompatSend;
use rig::{DynModel, Model};

use crate::anthropic::claude_messages;
use crate::openai::StatelessResponses;

const GO_URL: &str = "https://opencode.ai/inference/go";
const PAY_AS_YOU_GO_URL: &str = "https://opencode.ai/inference";
const USER_AGENT: &str = concat!("sprocket/", env!("CARGO_PKG_VERSION"));
const SESSION_HEADER: &str = "x-opencode-session";

/// Claude runs on OpenCode's Messages endpoint and every other model on its Responses one.
/// `session_id` keeps a thread on one route and prompt cache, which Go requires.
pub(crate) fn completion_model(
    api_key: String,
    model: &str,
    claude: bool,
    cache_write_ttl: Option<&str>,
    instructions: &str,
    session_id: &str,
) -> anyhow::Result<DynModel<Completion>> {
    let transport = PlanFallback {
        inner: rig::rig_reqwest::shared(),
        session: HeaderValue::from_str(session_id)?,
        pay_as_you_go: Arc::default(),
    };
    Ok(if claude {
        let config = AnthropicConfig::new(api_key).with_base_url(format!("{GO_URL}/anthropic"));
        Model::new(
            claude_messages(config, model, instructions, cache_write_ttl),
            transport,
        )
        .erase()
    } else {
        let config = OpenAIConfig::new(api_key)
            .with_base_url(format!("{GO_URL}/openai/v1"))
            .with_instructions(instructions);
        Model::new(StatelessResponses(Responses::new(config, model)), transport).erase()
    })
}

/// One OpenCode key may hold a Go subscription, pay-as-you-go credits, or both. Requests go
/// to Go first, and the model stays on pay-as-you-go once Go refuses one.
#[derive(Clone, Debug)]
struct PlanFallback {
    inner: DynHttpClient,
    session: HeaderValue,
    pay_as_you_go: Arc<AtomicBool>,
}

/// Go answers models outside its plan and keys without a subscription with client errors.
/// Rate limits and timeouts would fail the same way on pay-as-you-go.
fn go_refused(error: &http_client::Error) -> bool {
    error.non_success_status().is_some_and(|status| {
        status.is_client_error()
            && status != StatusCode::TOO_MANY_REQUESTS
            && status != StatusCode::REQUEST_TIMEOUT
    })
}

impl PlanFallback {
    fn on_go(&self) -> bool {
        !self.pay_as_you_go.load(Ordering::Relaxed)
    }

    fn prepare<T>(&self, mut request: Request<T>, go: bool) -> http_client::Result<Request<T>> {
        if !go {
            let uri = request
                .uri()
                .to_string()
                .replacen(GO_URL, PAY_AS_YOU_GO_URL, 1);
            *request.uri_mut() = uri.parse().map_err(http::Error::from)?;
        }
        let headers = request.headers_mut();
        headers.insert(
            http::header::USER_AGENT,
            HeaderValue::from_static(USER_AGENT),
        );
        headers.insert(SESSION_HEADER, self.session.clone());
        Ok(request)
    }

    async fn send_with_fallback<R, F, Fut>(
        &self,
        request: Request<Bytes>,
        send: F,
    ) -> http_client::Result<R>
    where
        F: Fn(Request<Bytes>) -> Fut,
        Fut: Future<Output = http_client::Result<R>>,
    {
        if self.on_go() {
            match send(self.prepare(request.clone(), true)?).await {
                Err(error) if go_refused(&error) => {
                    eprintln!(
                        "sprocket-agent: OpenCode Go refused the request ({error}); using pay-as-you-go"
                    );
                    self.pay_as_you_go.store(true, Ordering::Relaxed);
                }
                result => return result,
            }
        }
        send(self.prepare(request, false)?).await
    }
}

impl HttpClientExt for PlanFallback {
    fn send<T, U>(
        &self,
        req: Request<T>,
    ) -> impl Future<Output = http_client::Result<Response<LazyBody<U>>>> + WasmCompatSend + 'static
    where
        T: Into<Bytes>,
        T: WasmCompatSend,
        U: From<Bytes>,
        U: WasmCompatSend + 'static,
    {
        let this = self.clone();
        let request = req.map(Into::into);
        async move {
            this.send_with_fallback(request, |request| this.inner.send(request))
                .await
        }
    }

    fn send_multipart<U>(
        &self,
        req: Request<MultipartForm>,
    ) -> impl Future<Output = http_client::Result<Response<LazyBody<U>>>> + WasmCompatSend + 'static
    where
        U: From<Bytes>,
        U: WasmCompatSend + 'static,
    {
        let this = self.clone();
        async move {
            let request = this.prepare(req, this.on_go())?;
            this.inner.send_multipart(request).await
        }
    }

    fn send_streaming<T>(
        &self,
        req: Request<T>,
    ) -> impl Future<Output = http_client::Result<StreamingResponse>> + WasmCompatSend
    where
        T: Into<Bytes> + WasmCompatSend,
    {
        let request = req.map(Into::into);
        self.send_with_fallback(request, |request| self.inner.send_streaming(request))
    }
}

#[cfg(test)]
mod tests;
