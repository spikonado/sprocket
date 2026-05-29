use clap::Parser;
use sprocket_server::{RunOptions, ServerConfig, run};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("sprocket_server=error".parse()?),
        )
        .init();

    run(
        ServerConfig::parse(),
        RunOptions {
            quiet: true,
            ..RunOptions::default()
        },
    )
    .await
}
