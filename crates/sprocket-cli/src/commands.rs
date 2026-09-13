mod connection;

use std::time::Duration;

use anyhow::Context;
use clap::{Args, Parser};
use sprocket_server::ServerConfig;
use sprocket_server::cli_protocol::*;

use connection::Connection;

#[derive(Debug, Args)]
pub(crate) struct LoginArgs {
    /// Credential storage for this local profile. File storage is not encrypted.
    #[arg(long, value_enum)]
    credential_store: Option<CredentialStore>,
}

fn runtime() -> anyhow::Result<tokio::runtime::Runtime> {
    Ok(tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?)
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
    tokio::select! {
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
    }
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
