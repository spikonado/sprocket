mod connection;
mod output;

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use clap::{Args, Parser};
use sprocket_server::ServerConfig;
use sprocket_server::cli_protocol::*;

use connection::Connection;
use output::{Output, OutputFormat};

#[derive(Debug, Args)]
pub(crate) struct RunArgs {
    /// Task to send to the agent
    #[arg(
        required_unless_present = "prompt_file",
        conflicts_with = "prompt_file"
    )]
    prompt: Option<String>,
    /// Read the prompt from a UTF-8 file, or - for stdin
    #[arg(long)]
    prompt_file: Option<PathBuf>,
    /// Working directory, defaulting to the current directory
    #[arg(long, short = 'C')]
    directory: Option<PathBuf>,
    /// Send a follow-up to this thread instead of creating a new one
    #[arg(long)]
    thread: Option<String>,
    #[arg(long)]
    model: Option<String>,
    #[arg(long)]
    reasoning: Option<String>,
    #[arg(long, conflicts_with = "no_fast")]
    fast: bool,
    #[arg(long)]
    no_fast: bool,
    /// Return one JSON result instead of text
    #[arg(long, conflicts_with = "stream_json")]
    json: bool,
    /// Stream newline-delimited JSON events
    #[arg(long)]
    stream_json: bool,
    /// Cancel after a duration such as 30s, 10m, or 2h
    #[arg(long, value_parser = parse_duration)]
    timeout: Option<Duration>,
}

#[derive(Debug, Args)]
pub(crate) struct LoginArgs {
    /// Credential storage for this local profile. File storage is not encrypted.
    #[arg(long, value_enum)]
    credential_store: Option<CredentialStore>,
}

fn parse_duration(value: &str) -> Result<Duration, String> {
    let (number, multiplier) = if let Some(number) = value.strip_suffix('s') {
        (number, 1)
    } else if let Some(number) = value.strip_suffix('m') {
        (number, 60)
    } else if let Some(number) = value.strip_suffix('h') {
        (number, 3600)
    } else {
        (value, 1)
    };
    let seconds = number
        .parse::<u64>()
        .ok()
        .and_then(|number| number.checked_mul(multiplier))
        .filter(|seconds| *seconds > 0 && *seconds <= 365 * 24 * 3600)
        .ok_or_else(|| {
            "use a positive duration up to one year, such as 30s, 10m, or 2h".to_string()
        })?;
    Ok(Duration::from_secs(seconds))
}

fn prompt(args: &RunArgs) -> anyhow::Result<String> {
    const MAX_PROMPT_BYTES: u64 = 1024 * 1024;
    let prompt = if let Some(prompt) = &args.prompt {
        prompt.clone()
    } else {
        let path = args.prompt_file.as_ref().context("a prompt is required")?;
        let reader: Box<dyn Read> = if path.as_os_str() == "-" {
            Box::new(std::io::stdin())
        } else {
            Box::new(
                std::fs::File::open(path)
                    .with_context(|| format!("cannot read {}", path.display()))?,
            )
        };
        let mut text = String::new();
        reader
            .take(MAX_PROMPT_BYTES + 1)
            .read_to_string(&mut text)
            .context("prompt must be UTF-8")?;
        text
    };
    anyhow::ensure!(!prompt.trim().is_empty(), "prompt is empty");
    anyhow::ensure!(
        prompt.len() as u64 <= MAX_PROMPT_BYTES,
        "prompt exceeds 1 MiB"
    );
    Ok(prompt)
}

fn runtime() -> anyhow::Result<tokio::runtime::Runtime> {
    Ok(tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?)
}

pub(crate) fn run(args: RunArgs) -> anyhow::Result<u8> {
    let format = if args.stream_json {
        OutputFormat::StreamJson
    } else if args.json {
        OutputFormat::Json
    } else {
        OutputFormat::Text
    };
    let mut output = Output::new(format);
    let result = runtime()?.block_on(async {
        let prompt = prompt(&args)?;
        let directory = args
            .directory
            .clone()
            .map(Ok)
            .unwrap_or_else(std::env::current_dir)?;
        let directory = crate::resolve_launch_workspace(&directory)?;
        let connection = Connection::open(ServerConfig::try_parse_from(["sprocket"])?).await?;
        let result = run_connected(&connection, &args, prompt, directory, &mut output).await;
        connection.close().await;
        result
    });
    match result {
        Ok(code) => Ok(code),
        Err(error) => {
            output.failure(format!("{error:#}"))?;
            Ok(1)
        }
    }
}

async fn run_connected(
    connection: &Connection,
    args: &RunArgs,
    prompt: String,
    directory: String,
    output: &mut Output,
) -> anyhow::Result<u8> {
    require_login(connection).await?;
    let request = CliRunRequest {
        client_id: connection.client_id.clone(),
        prompt,
        directory,
        thread_id: args.thread.clone(),
        model: args.model.clone(),
        reasoning: args.reasoning.clone(),
        fast: if args.fast {
            Some(true)
        } else if args.no_fast {
            Some(false)
        } else {
            None
        },
    };
    output.submitting(&connection.client_id);
    let interrupted = {
        let operation = execute_run(connection, &request, output);
        tokio::pin!(operation);
        tokio::select! {
            result = &mut operation => return result,
            code = interrupt() => code,
            _ = async {
                match args.timeout {
                    Some(duration) => tokio::time::sleep(duration).await,
                    None => std::future::pending().await,
                }
            } => 124,
        }
    };
    output.interrupted(interrupted);
    if let Err(error) = connection
        .call::<bool>("cancel", &connection.client_request())
        .await
    {
        output.unknown(format!(
            "Could not confirm cancellation request; the run may still be active: {error}"
        ))?;
        return Ok(interrupted);
    }
    let confirmation = tokio::time::timeout(
        Duration::from_secs(15),
        execute_run(connection, &request, output),
    )
    .await;
    match confirmation {
        Ok(Ok(_)) => Ok(interrupted),
        _ => {
            output.unknown("Cancellation requested, but the final state could not be confirmed. Check the thread in Sprocket.".into())?;
            Ok(interrupted)
        }
    }
}

async fn execute_run(
    connection: &Connection,
    request: &CliRunRequest,
    output: &mut Output,
) -> anyhow::Result<u8> {
    if output.started().is_none() {
        let started: RunStarted = connection.retry("run", request).await?;
        output.start(started)?;
    }
    loop {
        let snapshot: CliRunSnapshot = connection
            .retry(
                "output",
                &CliOutputRequest {
                    client_id: connection.client_id.clone(),
                    after_part: output.after_part(),
                    after_revision: output.after_revision(),
                },
            )
            .await?;
        let done = snapshot.execution_finished && !snapshot.has_more;
        output.update(&snapshot)?;
        if done {
            let code = if snapshot.status == "completed" { 0 } else { 1 };
            output.finish(snapshot.status, snapshot.error)?;
            return Ok(code);
        }
    }
}

pub(crate) fn login(args: LoginArgs) -> anyhow::Result<u8> {
    runtime()?.block_on(async {
        let connection = Connection::open(ServerConfig::try_parse_from(["sprocket"])?).await?;
        let result = login_connected(&connection, args).await;
        connection.close().await;
        result
    })
}

async fn login_connected(connection: &Connection, args: LoginArgs) -> anyhow::Result<u8> {
    if args.credential_store.is_none() {
        if let LoginStatus::Authenticated { user } = connection
            .call("auth", &connection.client_request())
            .await?
        {
            eprintln!("Signed in as {}", user.email);
            return Ok(0);
        }
    }
    if args.credential_store == Some(CredentialStore::File) {
        eprintln!(
            "The refresh token will be stored unencrypted in a private file for this Sprocket profile."
        );
    }
    let authorization: DeviceLoginResponse = connection
        .call(
            "login",
            &CliLoginRequest {
                client_id: connection.client_id.clone(),
                credential_store: args.credential_store,
            },
        )
        .await?;
    eprintln!(
        "Open {} in a browser and approve code {}",
        authorization.verification_uri, authorization.user_code
    );
    let result = tokio::select! {
        code = interrupt() => Ok(code),
        result = tokio::time::timeout(Duration::from_secs(authorization.expires_in + 5), async {
            loop {
                match connection.retry("auth", &connection.client_request()).await? {
                    LoginStatus::Authenticated { user } => {
                        eprintln!("Signed in as {}", user.email);
                        return Ok(0);
                    }
                    LoginStatus::Failed { error } | LoginStatus::Unavailable { error } => anyhow::bail!("{error}"),
                    LoginStatus::SignedOut => anyhow::bail!("login was cancelled or invalidated"),
                    LoginStatus::Pending => tokio::time::sleep(Duration::from_secs(1)).await,
                }
            }
        }) => result.context("device login expired")?,
    };
    result
}

pub(crate) fn logout() -> anyhow::Result<u8> {
    runtime()?.block_on(async {
        let connection = Connection::open(ServerConfig::try_parse_from(["sprocket"])?).await?;
        let result = connection
            .call::<bool>("logout", &connection.client_request())
            .await;
        connection.close().await;
        result?;
        eprintln!("Signed out of this local Sprocket profile.");
        Ok(0)
    })
}

async fn require_login(connection: &Connection) -> anyhow::Result<()> {
    match connection
        .call("auth", &connection.client_request())
        .await?
    {
        LoginStatus::Authenticated { .. } => Ok(()),
        LoginStatus::Unavailable { error } | LoginStatus::Failed { error } => anyhow::bail!(
            "{error}. Run sprocket login, or use --credential-store file on a headless machine."
        ),
        _ => anyhow::bail!("not signed in; run sprocket login"),
    }
}

async fn interrupt() -> u8 {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        let mut hangup = signal(SignalKind::hangup()).expect("install SIGHUP handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => 130,
            _ = terminate.recv() => 143,
            _ = hangup.recv() => 129,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        130
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deadlines_are_positive_bounded_and_overflow_checked() {
        assert_eq!(parse_duration("2m").unwrap(), Duration::from_secs(120));
        for value in ["0", "-1", "1.5s", "1d", "18446744073709551615h"] {
            assert!(parse_duration(value).is_err(), "{value}");
        }
    }
}
