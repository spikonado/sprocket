use clap::Parser;
use sprocket_server::{RunOptions, ServerConfig, load_env_files, run};
use tracing_subscriber::EnvFilter;

fn main() -> anyhow::Result<()> {
    // SAFETY: this runs before the Tokio runtime is constructed.
    unsafe {
        load_env_files();
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("sprocket_server=error".parse()?),
        )
        .init();

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run(
            ServerConfig::parse(),
            RunOptions {
                quiet: true,
                ..RunOptions::default()
            },
        ))
}
