use clap::{Parser, Subcommand};
use sprocket_server::{INSTALLED_WEB_DIR, RunOptions, ServerConfig, load_env_files, run};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(
    name = "sprocket",
    about = "Local Sprocket development server",
    version,
    arg_required_else_help = false
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[command(flatten)]
    serve: ServeArgs,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Start the local Sprocket server and web app
    Serve(ServeArgs),
}

#[derive(Debug, Parser)]
struct ServeArgs {
    #[command(flatten)]
    server: ServerConfig,

    /// Open the web app in your default browser after startup
    #[arg(long)]
    open: bool,

    /// Only print machine-readable startup output
    #[arg(long, env = "SPROCKET_QUIET")]
    quiet: bool,
}

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

    let cli = Cli::parse();
    let serve = match cli.command {
        None => cli.serve,
        Some(Commands::Serve(serve)) => serve,
    };

    if !serve.server.api_only && serve.server.resolve_static_dir().is_none() {
        anyhow::bail!(
            "Web app files not found. Build them with `bun run --cwd apps/web build`, \
             or install them to `<prefix>/{INSTALLED_WEB_DIR}`, or pass `--api-only` with the Vite dev server."
        );
    }

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run(
            serve.server,
            RunOptions {
                quiet: serve.quiet,
                open_browser: serve.open,
            },
        ))
}
