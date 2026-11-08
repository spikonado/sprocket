use bytes::Bytes;
use rig::http_client::{self, Exchange, HeaderMap, HeaderValue, HttpMiddleware};
use rig::wasm_compat::WasmBoxedFuture;

// Codex's level. OpenAI documents zstd request bodies for POST /v1/responses.
const ZSTD_LEVEL: i32 = 3;

pub(crate) fn zstd_compress(body: &[u8]) -> std::io::Result<Vec<u8>> {
    zstd::bulk::compress(body, ZSTD_LEVEL)
}

/// Only for endpoints known to decode zstd request bodies.
pub(crate) struct ZstdResponsesRequests;

fn is_responses_post(exchange: Exchange<'_>) -> bool {
    *exchange.method == http::Method::POST && exchange.uri.path().ends_with("/responses")
}

impl HttpMiddleware for ZstdResponsesRequests {
    fn before_request_headers<'a>(
        &'a self,
        exchange: Exchange<'a>,
        headers: &'a mut HeaderMap,
    ) -> WasmBoxedFuture<'a, http_client::Result<()>> {
        if is_responses_post(exchange) {
            headers.insert(
                http::header::CONTENT_ENCODING,
                HeaderValue::from_static("zstd"),
            );
        }
        Box::pin(async { Ok(()) })
    }

    fn before_request_body<'a>(
        &'a self,
        exchange: Exchange<'a>,
        _headers: &'a HeaderMap,
        body: Bytes,
    ) -> WasmBoxedFuture<'a, http_client::Result<Bytes>> {
        let compressed = if is_responses_post(exchange) {
            zstd_compress(&body)
                .map(Bytes::from)
                .map_err(|error| http_client::Error::Instance(error.into()))
        } else {
            Ok(body)
        };
        Box::pin(async { compressed })
    }
}
