use std::time::Duration;

use anyhow::{Context, bail, ensure};
use base64::Engine;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::Jwk};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};

use super::{SignIn, Tokens, now};

pub(super) const ISSUER: &str = "https://auth.openai.com";
pub(super) const RESOURCE: &str = "https://api.openai.com/v1";
pub(super) const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
pub(super) const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
const RESPONSE_LIMIT: usize = 1024 * 1024;

#[derive(Deserialize)]
pub(super) struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: Option<String>,
    pub token_type: String,
    pub expires_in: u64,
    pub scope: Option<String>,
    pub earliest_refresh_at: Option<u64>,
}

#[derive(Clone, Deserialize)]
pub(super) struct Identity {
    pub sub: String,
    nonce: Option<String>,
    pub email: Option<String>,
}

pub(super) struct ReturningAccount<'a> {
    pub(super) id_token: Option<&'a str>,
    pub(super) email: Option<&'a str>,
}

#[derive(Deserialize)]
struct Discovery {
    issuer: String,
    revocation_endpoint: String,
}

#[derive(Deserialize)]
struct OAuthError {
    error: String,
}

pub(super) enum Refresh {
    Refreshed(Tokens),
    Retry(&'static str),
    Disconnect(anyhow::Error),
}

pub(super) fn scopes(value: &str) -> Vec<String> {
    value.split_whitespace().map(str::to_owned).collect()
}

pub(super) fn require_scopes(granted: &[String]) -> anyhow::Result<()> {
    ensure!(
        [
            "chatgpt.tokens.use.direct",
            "resource.invoke",
            "offline_access"
        ]
        .iter()
        .all(|required| granted.iter().any(|scope| scope == required)),
        "ChatGPT plan usage was not authorized. Reconnect and approve plan access."
    );
    Ok(())
}

pub(super) fn issued_client(
    selected: Option<&str>,
    callback: Option<&str>,
) -> anyhow::Result<String> {
    let client = match (selected, callback) {
        (Some(selected), Some(callback)) => {
            ensure!(
                selected == callback,
                "ChatGPT returned a different client registration."
            );
            selected
        }
        (Some(selected), None) => selected,
        (None, Some(callback)) => callback,
        (None, None) => {
            bail!("ChatGPT registration did not return an issued client ID. Start sign-in again.")
        }
    };
    ensure!(
        client != DYNAMIC_CLIENT && !client.is_empty() && client.len() <= 512,
        "ChatGPT returned an invalid client registration."
    );
    Ok(client.to_owned())
}

pub(super) fn token_tuple(
    response: TokenResponse,
    previous: Option<&Tokens>,
    received_at: u64,
) -> anyhow::Result<Tokens> {
    ensure!(
        response.token_type.eq_ignore_ascii_case("bearer"),
        "ChatGPT returned an unsupported token type."
    );
    ensure!(
        !response.access_token.is_empty()
            && !response.refresh_token.is_empty()
            && response.access_token.len() <= 128 * 1024
            && response.refresh_token.len() <= 128 * 1024,
        "ChatGPT returned invalid credentials."
    );
    ensure!(
        response.expires_in > 0 && response.expires_in <= 24 * 60 * 60,
        "ChatGPT returned invalid credential expiry."
    );
    let granted = match response.scope {
        Some(scope) => scopes(&scope),
        None => previous
            .context("ChatGPT did not return granted scopes.")?
            .scopes
            .clone(),
    };
    require_scopes(&granted)?;
    let id_token = response
        .id_token
        .or_else(|| previous.map(|tokens| tokens.id_token.clone()))
        .context("ChatGPT did not return an ID token.")?;
    ensure!(
        !id_token.is_empty() && id_token.len() <= 128 * 1024,
        "ChatGPT returned an invalid ID token."
    );
    Ok(Tokens {
        access_token: response.access_token,
        refresh_token: response.refresh_token,
        id_token,
        scopes: granted,
        expires_at: received_at
            .checked_add(response.expires_in)
            .context("Invalid expiry.")?,
        earliest_refresh_at: response.earliest_refresh_at.unwrap_or(received_at),
        refresh_in_flight: false,
    })
}

pub(super) fn verify_identity(
    token: &str,
    keys: &[Jwk],
    client_id: &str,
    nonce: Option<&str>,
) -> anyhow::Result<Identity> {
    let header = decode_header(token).map_err(|_| anyhow::anyhow!("Invalid ChatGPT ID token."))?;
    ensure!(
        header.alg == Algorithm::RS256,
        "Unsupported ChatGPT ID token signature."
    );
    let key_id = header.kid.context("ChatGPT ID token has no signing key.")?;
    let key = keys
        .iter()
        .find(|key| key.common.key_id.as_deref() == Some(key_id.as_str()))
        .context("Unknown ChatGPT signing key.")?;
    let key = DecodingKey::from_jwk(key).context("Invalid ChatGPT signing key.")?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[ISSUER]);
    validation.set_audience(&[client_id]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    validation.leeway = 0;
    validation.validate_nbf = true;
    let identity = decode::<Identity>(token, &key, &validation)
        .map_err(|_| anyhow::anyhow!("ChatGPT ID token verification failed."))?
        .claims;
    ensure!(
        !identity.sub.is_empty() && identity.sub.len() <= 1024,
        "Invalid ChatGPT subject."
    );
    if let Some(nonce) = nonce {
        ensure!(
            identity.nonce.as_deref() == Some(nonce),
            "ChatGPT ID token nonce did not match."
        );
    }
    Ok(identity)
}

async fn json<T: DeserializeOwned>(mut response: reqwest::Response) -> anyhow::Result<T> {
    ensure!(
        response
            .content_length()
            .is_none_or(|length| length <= RESPONSE_LIMIT as u64),
        "Provider returned an oversized response."
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .context("Could not read provider response.")?
    {
        ensure!(
            bytes.len().saturating_add(chunk.len()) <= RESPONSE_LIMIT,
            "Provider returned an oversized response."
        );
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("Provider returned an invalid response."))
}

pub(super) fn authorization_url(
    sign_in: &SignIn,
    state: &str,
    host_id: &str,
    client_id: &str,
    returning: Option<ReturningAccount<'_>>,
) -> anyhow::Result<String> {
    let mut url = url::Url::parse("https://auth.openai.com/api/accounts/authorize")?;
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(sign_in.verifier.as_bytes()));
    url.query_pairs_mut().extend_pairs([
        ("client_id", client_id),
        ("ext_agent_host_id", host_id),
        ("response_type", "code"),
        ("redirect_uri", sign_in.redirect_uri.as_str()),
        ("scope", SCOPES),
        ("resource", RESOURCE),
        ("state", state),
        ("nonce", sign_in.nonce.as_str()),
        ("code_challenge_method", "S256"),
        ("code_challenge", challenge.as_str()),
    ]);
    match returning {
        None => {
            url.query_pairs_mut()
                .append_pair("agent_name_hint", "Sprocket");
        }
        Some(returning) => {
            if let Some(id_token) = returning.id_token {
                url.query_pairs_mut().append_pair("id_token_hint", id_token);
            }
            if let Some(email) = returning.email {
                url.query_pairs_mut().append_pair("login_hint", email);
            }
        }
    }
    Ok(url.to_string())
}

pub(super) async fn identity(
    client: &reqwest::Client,
    issuer: &str,
    token: &str,
    client_id: &str,
    nonce: Option<&str>,
) -> anyhow::Result<Identity> {
    let response = client
        .get(format!("{issuer}/.well-known/jwks.json"))
        .send()
        .await
        .context("Could not retrieve ChatGPT signing keys.")?;
    ensure!(
        response.status().is_success(),
        "Could not retrieve ChatGPT signing keys."
    );
    let keys: jsonwebtoken::jwk::JwkSet = json(response).await?;
    verify_identity(token, &keys.keys, client_id, nonce)
}

pub(super) async fn exchange(
    client: &reqwest::Client,
    token_endpoint: &str,
    issuer: &str,
    client_id: &str,
    code: &str,
    sign_in: &SignIn,
    expected_subject: Option<&str>,
) -> anyhow::Result<(Tokens, Identity)> {
    let sent_at = now();
    let response = client
        .post(token_endpoint)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", client_id),
            ("code", code),
            ("code_verifier", sign_in.verifier.as_str()),
            ("redirect_uri", sign_in.redirect_uri.as_str()),
            ("resource", RESOURCE),
        ])
        .send()
        .await
        .context("Could not exchange ChatGPT sign-in. Start sign-in again.")?;
    ensure!(
        response.status().is_success(),
        "ChatGPT rejected sign-in. Start sign-in again."
    );
    let response: TokenResponse = json(response).await?;
    let refresh_token = response.refresh_token.clone();
    let outcome = async {
        let tokens = token_tuple(response, None, sent_at)?;
        let identity = identity(
            client,
            issuer,
            &tokens.id_token,
            client_id,
            Some(sign_in.nonce.as_str()),
        )
        .await?;
        if let Some(expected) = expected_subject {
            ensure!(
                identity.sub == expected,
                "ChatGPT signed in to a different account. Select Add account instead."
            );
        }
        Ok((tokens, identity))
    }
    .await;
    if outcome.is_err() {
        revoke(client, issuer, client_id, &refresh_token).await;
    }
    outcome
}

pub(super) async fn refresh(
    client: &reqwest::Client,
    token_endpoint: &str,
    issuer: &str,
    client_id: &str,
    subject: &str,
    tokens: &Tokens,
) -> Refresh {
    let sent_at = now();
    let result = client
        .post(token_endpoint)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("refresh_token", tokens.refresh_token.as_str()),
            ("resource", RESOURCE),
        ])
        .send()
        .await;
    let response = match result {
        Ok(response) => response,
        Err(error) if error.is_timeout() => {
            return Refresh::Retry("ChatGPT refresh timed out. Retry when connectivity returns.");
        }
        Err(error) if error.is_connect() => {
            return Refresh::Retry(
                "Could not connect to ChatGPT to refresh credentials. Retry when connectivity returns.",
            );
        }
        Err(_) => {
            return Refresh::Disconnect(anyhow::anyhow!(
                "ChatGPT refresh was interrupted. Reconnect locally in Settings."
            ));
        }
    };
    let status = response.status();
    if !status.is_success() {
        let terminal = json::<OAuthError>(response)
            .await
            .ok()
            .is_some_and(|error| {
                [
                    "invalid_grant",
                    "refresh_token_expired",
                    "refresh_token_reused",
                    "refresh_token_invalidated",
                    "token_revoked",
                ]
                .contains(&error.error.as_str())
            });
        if !terminal && (status.is_server_error() || status.as_u16() == 429) {
            return Refresh::Retry("ChatGPT refresh is temporarily unavailable. Retry later.");
        }
        return Refresh::Disconnect(anyhow::anyhow!(if terminal {
            "ChatGPT session expired. Reconnect locally in Settings."
        } else {
            "ChatGPT refresh could not be completed safely. Reconnect locally in Settings."
        }));
    }
    let response: TokenResponse = match json(response).await {
        Ok(response) => response,
        Err(error) => return Refresh::Disconnect(error),
    };
    let issued_refresh = response.refresh_token.clone();
    let refreshed = async {
        if let Some(id_token) = &response.id_token {
            let identity = identity(client, issuer, id_token, client_id, None).await?;
            ensure!(
                identity.sub == subject,
                "ChatGPT refresh returned another identity."
            );
        }
        token_tuple(response, Some(tokens), sent_at)
    }
    .await;
    match refreshed {
        Ok(refreshed) => Refresh::Refreshed(refreshed),
        Err(error) => {
            revoke(client, issuer, client_id, &issued_refresh).await;
            Refresh::Disconnect(error)
        }
    }
}

pub(super) async fn revoke(
    client: &reqwest::Client,
    issuer: &str,
    client_id: &str,
    refresh_token: &str,
) -> bool {
    let discovery = async {
        let response = client
            .get(format!("{issuer}/.well-known/openid-configuration"))
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let discovery: Discovery = json(response).await.ok()?;
        let endpoint = url::Url::parse(&discovery.revocation_endpoint).ok()?;
        let issuer_url = url::Url::parse(issuer).ok()?;
        if discovery.issuer != issuer
            || endpoint.origin() != issuer_url.origin()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
        {
            return None;
        }
        Some(endpoint)
    }
    .await;
    let Some(endpoint) = discovery else {
        return false;
    };
    for attempt in 0..2 {
        let response = client
            .post(endpoint.clone())
            .timeout(Duration::from_secs(5))
            .form(&[
                ("token", refresh_token),
                ("token_type_hint", "refresh_token"),
                ("client_id", client_id),
            ])
            .send()
            .await;
        match response {
            Ok(response) if response.status().as_u16() == 200 => return true,
            Ok(response) if !response.status().is_server_error() => return false,
            _ => {}
        }
        if attempt == 0 {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
    false
}
