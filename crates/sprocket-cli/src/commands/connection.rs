use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::Context;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sprocket_server::cli_protocol::{
    CLI_PROTOCOL_VERSION, CliBootstrapRequest, CliBootstrapResponse, CliClientRequest,
    CliConnectRequest, CliDiscovery, cli_bootstrap_message, cli_bootstrap_response_message,
    cli_discovery_message,
};
use sprocket_server::{
    PairingProofRequest, ServerConfig, read_pairing_credential, read_server_address,
    sign_pairing_proof, verify_pairing_proof,
};

pub(super) struct Connection {
    http: reqwest::Client,
    base_url: String,
    session_token: String,
    pub client_id: String,
    heartbeat: tokio::task::JoinHandle<()>,
}

#[derive(Debug)]
struct HttpError {
    status: reqwest::StatusCode,
    message: String,
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for HttpError {}

#[derive(Deserialize)]
struct ErrorResponse {
    error: String,
}

impl Connection {
    pub async fn open(config: ServerConfig) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(20))
            .build()?;
        validate_local_url(&config.listen_url())?;
        let discovered = if let Some(url) = discover(&http, &config).await? {
            url
        } else {
            spawn_server(&config)?;
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                if let Some(url) = discover(&http, &config).await? {
                    break url;
                }
                anyhow::ensure!(
                    Instant::now() < deadline,
                    "local server did not start; see {}",
                    config.resolve_data_dir().join("cli-server.log").display()
                );
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        };
        let credential = read_pairing_credential(&config)?
            .context("local server pairing credential is missing")?;
        let base_url = discovered.http_base_url;
        let session_token = uuid::Uuid::new_v4().to_string();
        let client_id = uuid::Uuid::new_v4().to_string();
        let mut bootstrap = CliBootstrapRequest {
            client: CliConnectRequest {
                client_id: client_id.clone(),
                protocol_version: CLI_PROTOCOL_VERSION,
                deployment_url: config.resolve_convex_deployment_url()?,
            },
            session_token: session_token.clone(),
            proof: Vec::new(),
        };
        bootstrap.proof = sign_pairing_proof(
            &credential,
            &cli_bootstrap_message(&discovered.instance_id, &base_url, &bootstrap),
        )?;
        let response: CliBootstrapResponse =
            post(&http, &base_url, "", "bootstrap", &bootstrap).await?;
        anyhow::ensure!(
            verify_pairing_proof(
                &credential,
                &cli_bootstrap_response_message(&discovered.instance_id, &base_url, &bootstrap),
                &response.proof
            ),
            "local server identity changed during pairing"
        );
        let heartbeat = {
            let http = http.clone();
            let base_url = base_url.clone();
            let token = session_token.clone();
            let request = CliClientRequest {
                client_id: client_id.clone(),
            };
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    let _ = post::<bool>(&http, &base_url, &token, "heartbeat", &request).await;
                }
            })
        };
        Ok(Self {
            http,
            base_url,
            session_token,
            client_id,
            heartbeat,
        })
    }

    pub fn client_request(&self) -> CliClientRequest {
        CliClientRequest {
            client_id: self.client_id.clone(),
        }
    }

    pub async fn call<T: DeserializeOwned>(
        &self,
        operation: &str,
        request: &impl Serialize,
    ) -> anyhow::Result<T> {
        post(
            &self.http,
            &self.base_url,
            &self.session_token,
            operation,
            request,
        )
        .await
    }

    pub async fn retry<T: DeserializeOwned>(
        &self,
        operation: &str,
        request: &impl Serialize,
    ) -> anyhow::Result<T> {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut delay = Duration::from_millis(250);
        loop {
            match self.call(operation, request).await {
                Ok(value) => return Ok(value),
                Err(error) if transient(&error) && Instant::now() < deadline => {
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(Duration::from_secs(2));
                }
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("{operation} failed for submission cli:{}", self.client_id)
                    });
                }
            }
        }
    }

    pub async fn close(self) {
        let _ = tokio::time::timeout(
            Duration::from_secs(3),
            self.call::<bool>("release", &self.client_request()),
        )
        .await;
        self.heartbeat.abort();
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.heartbeat.abort();
    }
}

async fn post<T: DeserializeOwned>(
    http: &reqwest::Client,
    base_url: &str,
    token: &str,
    operation: &str,
    request: &impl Serialize,
) -> anyhow::Result<T> {
    let response = http
        .post(format!("{base_url}/api/cli/{operation}"))
        .bearer_auth(token)
        .json(request)
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let message = response
            .json::<ErrorResponse>()
            .await
            .map(|response| response.error)
            .unwrap_or_else(|_| format!("local server returned {status}"));
        let message = if status == reqwest::StatusCode::NOT_FOUND {
            format!("{message}. Update and restart the local Sprocket server to use CLI commands.")
        } else {
            message
        };
        return Err(HttpError { status, message }.into());
    }
    response
        .json()
        .await
        .context("invalid response from the local server")
}

fn transient(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<reqwest::Error>()
        .is_some_and(|error| error.is_timeout() || error.is_connect() || error.is_body())
        || error
            .downcast_ref::<HttpError>()
            .is_some_and(|error| matches!(error.status.as_u16(), 408 | 429 | 500 | 502 | 503 | 504))
}

fn validate_local_url(value: &str) -> anyhow::Result<()> {
    let url = reqwest::Url::parse(value)?;
    anyhow::ensure!(
        url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/",
        "CLI server address must be an HTTP loopback origin"
    );
    Ok(())
}

async fn discover(
    http: &reqwest::Client,
    config: &ServerConfig,
) -> anyhow::Result<Option<CliDiscovery>> {
    let mut candidates = Vec::new();
    if let Some(address) = read_server_address(&config.resolve_data_dir())? {
        candidates.push(address);
    }
    if !candidates.contains(&config.listen_url()) {
        candidates.push(config.listen_url());
    }
    for base_url in candidates {
        validate_local_url(&base_url)?;
        let challenge = uuid::Uuid::new_v4().to_string();
        let response = match http
            .post(format!("{base_url}/api/cli/discovery"))
            .timeout(Duration::from_millis(750))
            .json(&PairingProofRequest {
                challenge: challenge.clone(),
            })
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) if error.is_connect() || error.is_timeout() => continue,
            Err(error) => return Err(error.into()),
        };
        anyhow::ensure!(
            response.status().is_success(),
            "{base_url} is occupied by an incompatible service. Update and restart the local Sprocket server."
        );
        let proof: CliDiscovery = response
            .json()
            .await
            .context("invalid local server identity")?;
        let credential = read_pairing_credential(config)?
            .context("local server uses a different Sprocket data directory")?;
        anyhow::ensure!(
            proof.http_base_url.trim_end_matches('/') == base_url
                && verify_pairing_proof(
                    &credential,
                    &cli_discovery_message(&challenge, &proof.instance_id, &proof.http_base_url),
                    &proof.proof
                ),
            "local server identity does not match this Sprocket profile"
        );
        return Ok(Some(proof));
    }
    Ok(None)
}

fn spawn_server(config: &ServerConfig) -> anyhow::Result<()> {
    let data_dir = config.resolve_data_dir();
    std::fs::create_dir_all(&data_dir)?;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let log = options.open(data_dir.join("cli-server.log"))?;
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args([
            "serve",
            "--quiet",
            "--cli-temporary",
            "--host",
            &config.host,
            "--port",
            &config.port.to_string(),
            "--convex-deployment-url",
            &config.resolve_convex_deployment_url()?,
            "--data-dir",
        ])
        .arg(&data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    match config.resolve_static_dir() {
        Some(directory) => {
            command.arg("--static-dir").arg(directory);
        }
        None => {
            command.arg("--api-only");
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x00000008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    let mut child = command
        .spawn()
        .context("failed to start the local Sprocket server")?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_discovery_never_sends_pairing_material_off_machine() {
        for url in [
            "http://127.0.0.1:17731",
            "http://localhost:7731",
            "http://[::1]:17731",
        ] {
            assert!(validate_local_url(url).is_ok());
        }
        for url in [
            "https://example.com",
            "http://127.0.0.1.evil.test",
            "http://user@localhost",
            "http://localhost/api",
            "http://localhost?x=1",
        ] {
            assert!(validate_local_url(url).is_err());
        }
    }
}
