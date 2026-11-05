mod commands;

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::Context;
use clap::{Args, Parser, Subcommand};
use tinker_server::{
    INSTALLED_WEB_DIR, PairingProofRequest, PairingProofResponse, RunOptions, ServerConfig,
    ServerExit, browser_launch_url, load_repo_env, pairing_proof_message, read_pairing_credential,
    run, verify_pairing_proof,
};
use tinker_workspace::{TINKER_VERSION, resolve_workspace_root};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

const DESKTOP_EXECUTABLE_ENV: &str = "TINKER_DESKTOP_EXECUTABLE";
const DESKTOP_WORKSPACE_ARG: &str = "--tinker-workspace";
const RESTART_EXIT_CODE: u8 = 75;
const RESTARTED_ENV: &str = "TINKER_RESTARTED";
#[derive(Debug, Parser)]
#[command(
    name = "tinker",
    about = "The best and only AI agent for developing both hardware and software",
    version = TINKER_VERSION,
    arg_required_else_help = false
)]
struct Cli {
    /// Launch only the web app in the default browser
    #[arg(long)]
    web: bool,

    /// Open this directory as a workspace in a new thread
    #[arg(value_name = "DIRECTORY")]
    directory: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Run an agent locally and wait for its result
    Run(commands::RunArgs),

    /// Sign in using a browser on any device
    Login(commands::LoginArgs),

    /// Sign out of this local profile in the app and CLI
    Logout,
    /// Start only the local Tinker server
    Serve(ServeArgs),

    /// Update a global npm, bun, pnpm, or yarn installation on its current channel
    #[command(visible_alias = "upgrade")]
    Update(UpdateArgs),
}

#[derive(Debug, Args)]
struct ServeArgs {
    #[arg(long, hide = true)]
    cli_temporary: bool,
    #[command(flatten)]
    server: ServerConfig,

    /// Only print machine-readable startup output
    #[arg(long, env = "TINKER_QUIET")]
    quiet: bool,
}

#[derive(Debug, Args)]
struct UpdateArgs {
    /// Report whether an update is available without installing it
    #[arg(long)]
    check: bool,
}

fn main() -> std::process::ExitCode {
    match entry() {
        Ok(code) => std::process::ExitCode::from(code),
        Err(error) => {
            eprintln!("{error:#}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn entry() -> anyhow::Result<u8> {
    let restarted = std::env::var_os(RESTARTED_ENV).is_some();
    // SAFETY: this runs before the Tokio runtime is constructed.
    unsafe {
        // Keep agent shells from inheriting the restart marker.
        std::env::remove_var(RESTARTED_ENV);
        load_repo_env();
    }

    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("tinker_server=error".parse()?),
        )
        .init();

    let cli = Cli::parse();
    let workspace_path = cli
        .directory
        .as_deref()
        .map(resolve_launch_workspace)
        .transpose()?;
    match cli.command {
        Some(Commands::Run(args)) => {
            anyhow::ensure!(
                !cli.web && workspace_path.is_none(),
                "run does not accept app launch arguments; use run --directory instead"
            );
            return commands::run(args);
        }
        Some(Commands::Login(args)) => {
            anyhow::ensure!(
                !cli.web && workspace_path.is_none(),
                "login does not accept app launch arguments"
            );
            return commands::login(args);
        }
        Some(Commands::Logout) => {
            anyhow::ensure!(
                !cli.web && workspace_path.is_none(),
                "logout does not accept app launch arguments"
            );
            return commands::logout();
        }
        Some(Commands::Serve(serve)) => {
            if cli.web {
                anyhow::bail!("`--web` cannot be combined with `serve`; run `tinker --web`");
            }
            if workspace_path.is_some() {
                anyhow::bail!("a workspace directory cannot be combined with `serve`");
            }
            serve_local(serve.server, serve.quiet, false, None, serve.cli_temporary)
        }
        Some(Commands::Update(_)) => {
            anyhow::bail!("`tinker update` requires the usetinker package launcher")
        }
        None if cli.web => {
            let server = ServerConfig::try_parse_from(["tinker"])?;
            serve_local(server, false, !restarted, workspace_path, false)
        }
        None => {
            if !restarted {
                if launch_desktop(workspace_path.as_deref())? {
                    return Ok(0);
                }

                eprintln!(
                    "The desktop app is not installed on this system, running Tinker in the browser instead.\n\
                     Note: This has no impact on Tinker's capabilities or performance."
                );
            }
            let server = ServerConfig::try_parse_from(["tinker"])?;
            serve_local(server, false, !restarted, workspace_path, false)
        }
    }
}

fn resolve_launch_workspace(path: &Path) -> anyhow::Result<String> {
    let path = path
        .to_str()
        .context("workspace paths must contain valid UTF-8")?;
    resolve_workspace_root(path)?
        .to_str()
        .map(str::to_string)
        .context("workspace paths must contain valid UTF-8")
}

fn serve_local(
    server: ServerConfig,
    quiet: bool,
    open_browser: bool,
    workspace_path: Option<String>,
    temporary: bool,
) -> anyhow::Result<u8> {
    let exit = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(async move {
            if open_browser
                && open_running_web_app(&server, workspace_path.as_deref()).await?
            {
                return Ok(ServerExit::Stopped);
            }

            if !server.api_only && server.resolve_static_dir().is_none() {
                anyhow::bail!(
                    "Web app files not found. Build them with `bun run --cwd apps/web build`, \
                     or install them to `<prefix>/{INSTALLED_WEB_DIR}`, or pass `--api-only` with the Vite dev server."
                );
            }

            if let Err(error) = init_analytics().await {
                tracing::warn!("analytics disabled: {error:#}");
            }
            let exit = run(
                server,
                RunOptions {
                    temporary,
                    quiet,
                    open_browser,
                    workspace_path,
                },
            )
            .await;
            posthog_rs::shutdown().await;
            exit
        })?;
    Ok(match exit {
        ServerExit::Stopped => 0,
        ServerExit::Restart => RESTART_EXIT_CODE,
    })
}

async fn init_analytics() -> anyhow::Result<()> {
    let Some(api_key) = std::env::var("PUBLIC_POSTHOG_KEY")
        .ok()
        .filter(|key| !key.trim().is_empty())
    else {
        return Ok(());
    };
    let error_tracking = posthog_rs::ErrorTrackingOptionsBuilder::default()
        .capture_panics(true)
        .build()?;
    let options = posthog_rs::ClientOptionsBuilder::default()
        .api_key(api_key)
        .host(posthog_rs::EU_INGESTION_ENDPOINT)
        .is_server(false)
        // Bounds how long exit and restart wait on an unreachable PostHog.
        .request_timeout_seconds(5)
        .shutdown_timeout_ms(2_000)
        .error_tracking(error_tracking)
        .before_send(|mut event| {
            let _ = event.insert_prop("site", "sprocket_app");
            let _ = event.insert_prop("app_version", TINKER_VERSION);
            Some(event)
        })
        .build()?;
    posthog_rs::init_global(options).await?;
    Ok(())
}

async fn open_running_web_app(
    server: &ServerConfig,
    workspace_path: Option<&str>,
) -> anyhow::Result<bool> {
    let expected_base_url = server.listen_url();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(750))
        .retry(reqwest::retry::never())
        .build()?;
    let challenge = Uuid::new_v4().to_string();
    let response = match client
        .post(format!("{expected_base_url}/api/auth/pairing-proof"))
        .json(&PairingProofRequest {
            challenge: challenge.clone(),
        })
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response,
        Ok(_) => anyhow::bail!(
            "Port {} is already used by another service; set TINKER_PORT to a free port",
            server.port
        ),
        // No Tinker server proved itself. Windows filter drivers can swallow
        // SYNs to dead loopback ports, so a timeout is not a fatal signal here;
        // the subsequent TCP bind is the authoritative check.
        Err(error) if error.is_connect() || error.is_timeout() => return Ok(false),
        Err(error) => return Err(error).context("failed to check for a running Tinker server"),
    };
    let pairing_proof = response
        .json::<PairingProofResponse>()
        .await
        .with_context(|| {
        format!(
            "port {} is already used by a service that is not Tinker; set TINKER_PORT to a free port",
            server.port
        )
    })?;
    if pairing_proof.http_base_url.trim_end_matches('/') != expected_base_url {
        anyhow::bail!(
            "Port {} is already used by a different Tinker configuration; set TINKER_PORT to a free port",
            server.port
        );
    }

    let data_dir = server.resolve_data_dir();
    let Some(credential) = read_pairing_credential(server)? else {
        anyhow::bail!(
            "Tinker is already running at {expected_base_url}, but its pairing credential was not found in {}. Set TINKER_DATA_DIR to the running server's data directory",
            data_dir.display()
        );
    };
    let message = pairing_proof_message(
        &challenge,
        &pairing_proof.http_base_url,
        pairing_proof.web_ui_enabled,
    );
    if !verify_pairing_proof(&credential, &message, &pairing_proof.proof) {
        anyhow::bail!(
            "Tinker is already running at {expected_base_url}, but it uses a different data directory. Set TINKER_DATA_DIR to the running server's data directory"
        );
    }
    if !pairing_proof.web_ui_enabled {
        anyhow::bail!(
            "Tinker is already running at {expected_base_url} in API-only mode; stop it or set TINKER_PORT to launch the web app on a different port"
        );
    }

    let target = browser_launch_url(&expected_base_url, workspace_path);
    eprintln!("Tinker is already running. Opening it in your browser…");
    open::that_detached(&target)
        .with_context(|| format!("failed to open the browser; open {target} manually"))?;
    Ok(true)
}

fn launch_desktop(workspace_path: Option<&str>) -> anyhow::Result<bool> {
    if let Some(target) = std::env::var_os(DESKTOP_EXECUTABLE_ENV).filter(|value| !value.is_empty())
    {
        spawn_desktop(Command::new(&target), workspace_path).with_context(|| {
            format!(
                "failed to launch desktop app from {DESKTOP_EXECUTABLE_ENV}={}",
                Path::new(&target).display()
            )
        })?;
        return Ok(true);
    }

    match spawn_desktop(Command::new(DESKTOP_EXECUTABLE_NAME), workspace_path) {
        Ok(()) => return Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("failed to launch Tinker desktop app"),
    }

    if let Some(launcher) = find_dev_desktop_launcher() {
        let mut command = Command::new("node");
        command.arg(launcher);
        match spawn_desktop(command, workspace_path) {
            Ok(()) => return Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).context("failed to launch the desktop app with Node.js");
            }
        }
    }

    Ok(false)
}

fn spawn_desktop(mut command: Command, workspace_path: Option<&str>) -> std::io::Result<()> {
    // Electron treats this development override as a request to run its binary as Node.js.
    command.env_remove("ELECTRON_RUN_AS_NODE");
    if let Some(workspace_path) = workspace_path {
        command.arg(format!("{DESKTOP_WORKSPACE_ARG}={workspace_path}"));
    }

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

const DESKTOP_EXECUTABLE_NAME: &str = if cfg!(windows) {
    "tinker-desktop.exe"
} else {
    "tinker-desktop"
};

#[cfg(debug_assertions)]
fn find_dev_desktop_launcher() -> Option<PathBuf> {
    let candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/launch.cjs");
    candidate.is_file().then_some(candidate)
}

#[cfg(not(debug_assertions))]
fn find_dev_desktop_launcher() -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests;
