use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::Context;
use clap::{Parser, Subcommand};
use sprocket_server::{
    INSTALLED_WEB_DIR, PairingProofRequest, PairingProofResponse, RunOptions, ServerConfig,
    browser_launch_url, load_repo_env, pairing_proof_message, read_pairing_credential, run,
    verify_pairing_proof,
};
use sprocket_workspace::resolve_workspace_root;
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

const DESKTOP_EXECUTABLE_ENV: &str = "SPROCKET_DESKTOP_EXECUTABLE";
const DESKTOP_WORKSPACE_ARG: &str = "--sprocket-workspace";
const VERSION: &str = match option_env!("SPROCKET_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

#[derive(Debug, Parser)]
#[command(
    name = "sprocket",
    about = "Agentic platform for streamlining hardware and software development",
    version = VERSION,
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
    /// Start only the local Sprocket server
    Serve(ServeArgs),
}

#[derive(Debug, Parser)]
struct ServeArgs {
    #[command(flatten)]
    server: ServerConfig,

    /// Only print machine-readable startup output
    #[arg(long, env = "SPROCKET_QUIET")]
    quiet: bool,
}

fn main() -> anyhow::Result<()> {
    // SAFETY: this runs before the Tokio runtime is constructed.
    unsafe {
        load_repo_env();
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("sprocket_server=error".parse()?),
        )
        .init();

    let cli = Cli::parse();
    let workspace_path = cli
        .directory
        .as_deref()
        .map(resolve_launch_workspace)
        .transpose()?;
    match cli.command {
        Some(Commands::Serve(serve)) => {
            if cli.web {
                anyhow::bail!("`--web` cannot be combined with `serve`; run `sprocket --web`");
            }
            if workspace_path.is_some() {
                anyhow::bail!("a workspace directory cannot be combined with `serve`");
            }
            serve_local(serve.server, serve.quiet, false, None)
        }
        None if cli.web => {
            let server = ServerConfig::try_parse_from(["sprocket"])?;
            serve_local(server, false, true, workspace_path)
        }
        None => {
            if launch_desktop(workspace_path.as_deref())? {
                return Ok(());
            }

            eprintln!(
                "The desktop app is not installed on this system, running Sprocket in the browser instead.\n\
                 Note: This has no impact on Sprocket's capabilities or performance."
            );
            let server = ServerConfig::try_parse_from(["sprocket"])?;
            serve_local(server, false, true, workspace_path)
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
) -> anyhow::Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(async move {
            if open_browser
                && open_running_web_app(&server, workspace_path.as_deref()).await?
            {
                return Ok(());
            }

            if !server.api_only && server.resolve_static_dir().is_none() {
                anyhow::bail!(
                    "Web app files not found. Build them with `bun run --cwd apps/web build`, \
                     or install them to `<prefix>/{INSTALLED_WEB_DIR}`, or pass `--api-only` with the Vite dev server."
                );
            }

            run(
                server,
                RunOptions {
                    quiet,
                    open_browser,
                    workspace_path,
                },
            )
            .await
        })
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
            "Port {} is already used by another service; set SPROCKET_PORT to a free port",
            server.port
        ),
        // No Sprocket server proved itself. Windows filter drivers can swallow
        // SYNs to dead loopback ports, so a timeout is not a fatal signal here;
        // the subsequent TCP bind is the authoritative check.
        Err(error) if error.is_connect() || error.is_timeout() => return Ok(false),
        Err(error) => return Err(error).context("failed to check for a running Sprocket server"),
    };
    let pairing_proof = response
        .json::<PairingProofResponse>()
        .await
        .with_context(|| {
        format!(
            "port {} is already used by a service that is not Sprocket; set SPROCKET_PORT to a free port",
            server.port
        )
    })?;
    if pairing_proof.http_base_url.trim_end_matches('/') != expected_base_url {
        anyhow::bail!(
            "Port {} is already used by a different Sprocket configuration; set SPROCKET_PORT to a free port",
            server.port
        );
    }

    let data_dir = server.resolve_data_dir();
    let Some(credential) = read_pairing_credential(server)? else {
        anyhow::bail!(
            "Sprocket is already running at {expected_base_url}, but its pairing credential was not found in {}. Set SPROCKET_DATA_DIR to the running server's data directory",
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
            "Sprocket is already running at {expected_base_url}, but it uses a different data directory. Set SPROCKET_DATA_DIR to the running server's data directory"
        );
    }
    if !pairing_proof.web_ui_enabled {
        anyhow::bail!(
            "Sprocket is already running at {expected_base_url} in API-only mode; stop it or set SPROCKET_PORT to launch the web app on a different port"
        );
    }

    let target = browser_launch_url(&expected_base_url, &credential, workspace_path);
    eprintln!("Sprocket is already running. Opening it in your browser…");
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
        Err(error) => return Err(error).context("failed to launch Sprocket desktop app"),
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
    "sprocket-desktop.exe"
} else {
    "sprocket-desktop"
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
mod tests {
    use super::*;

    #[test]
    fn parses_desktop_web_and_server_modes() {
        let desktop = Cli::try_parse_from(["sprocket"]).unwrap();
        assert!(!desktop.web);
        assert!(desktop.directory.is_none());
        assert!(desktop.command.is_none());

        let web = Cli::try_parse_from(["sprocket", "--web", "./robot"]).unwrap();
        assert!(web.web);
        assert_eq!(web.directory, Some(PathBuf::from("./robot")));
        assert!(web.command.is_none());

        let workspace = Cli::try_parse_from(["sprocket", "/tmp/robot"]).unwrap();
        assert_eq!(workspace.directory, Some(PathBuf::from("/tmp/robot")));
        assert!(workspace.command.is_none());

        let server = Cli::try_parse_from(["sprocket", "serve", "--quiet"]).unwrap();
        assert!(!server.web);
        assert!(server.directory.is_none());
        assert!(matches!(server.command, Some(Commands::Serve(_))));
    }
}
