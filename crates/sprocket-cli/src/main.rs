use std::io::ErrorKind;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use anyhow::Context;
use clap::{Parser, Subcommand};
use sprocket_server::{INSTALLED_WEB_DIR, RunOptions, ServerConfig, load_repo_env, run};
use tracing_subscriber::EnvFilter;

const DESKTOP_EXECUTABLE_ENV: &str = "SPROCKET_DESKTOP_EXECUTABLE";

#[derive(Debug, Parser)]
#[command(
    name = "sprocket",
    about = "Sprocket robotics development platform",
    version,
    arg_required_else_help = false
)]
struct Cli {
    /// Launch only the web app in the default browser
    #[arg(long)]
    web: bool,

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
        load_repo_env();
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("sprocket_server=error".parse()?),
        )
        .init();

    let cli = Cli::parse();
    match cli.command {
        Some(Commands::Serve(serve)) => {
            if cli.web {
                anyhow::bail!("`--web` cannot be combined with `serve`; use `serve --open`");
            }
            serve_local(serve.server, serve.quiet, serve.open)
        }
        None => {
            if cli.web {
                eprintln!("Opening Sprocket in your browser…");
            }
            if launch_desktop(cli.web)? {
                return Ok(());
            }

            if cli.web {
                let server = ServerConfig::try_parse_from(["sprocket"])?;
                return serve_local(server, false, true);
            }

            anyhow::bail!(
                "Sprocket desktop app was not found. Install it alongside the CLI, or set \
                 {DESKTOP_EXECUTABLE_ENV} to its executable path. Use `sprocket --web` to launch \
                 the browser app without the desktop app."
            )
        }
    }
}

fn serve_local(server: ServerConfig, quiet: bool, open_browser: bool) -> anyhow::Result<()> {
    if !server.api_only && server.resolve_static_dir().is_none() {
        anyhow::bail!(
            "Web app files not found. Build them with `bun run --cwd apps/web build`, \
             or install them to `<prefix>/{INSTALLED_WEB_DIR}`, or pass `--api-only` with the Vite dev server."
        );
    }

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run(
            server,
            RunOptions {
                quiet,
                open_browser,
            },
        ))
}

fn launch_desktop(web_only: bool) -> anyhow::Result<bool> {
    let desktop_executable = std::env::var_os(DESKTOP_EXECUTABLE_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            installed_desktop_candidates()
                .into_iter()
                .find(|candidate| candidate.is_file())
        });

    if let Some(target) = desktop_executable {
        spawn_desktop(Command::new(&target), web_only)
            .with_context(|| format!("failed to launch {}", target.display()))?;
        return Ok(true);
    }

    match spawn_desktop(Command::new(DESKTOP_EXECUTABLE_NAME), web_only) {
        Ok(()) => return Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("failed to launch Sprocket desktop app"),
    }

    if let Some(launcher) = find_dev_desktop_launcher() {
        let mut command = Command::new("node");
        command.arg(launcher);
        match spawn_desktop(command, web_only) {
            Ok(()) => return Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).context("failed to launch the desktop app with Node.js");
            }
        }
    }

    Ok(false)
}

fn spawn_desktop(mut command: Command, web_only: bool) -> std::io::Result<()> {
    if web_only {
        command.arg("--web");
        let status = command
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()?;
        if !status.success() {
            return Err(std::io::Error::other(format!(
                "Sprocket desktop app exited with {status}"
            )));
        }
        return Ok(());
    }

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

fn installed_desktop_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(executable) = std::env::current_exe()
        && let Some(executable_dir) = executable.parent()
    {
        candidates.push(executable_dir.join(DESKTOP_EXECUTABLE_NAME));

        #[cfg(target_os = "macos")]
        candidates.push(executable_dir.join("MacOS/sprocket-desktop"));
    }

    #[cfg(target_os = "linux")]
    {
        candidates.push(PathBuf::from("/opt/Sprocket/sprocket-desktop"));
        candidates.push(PathBuf::from("/opt/sprocket/sprocket-desktop"));
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            candidates.push(home.join(".local/bin/sprocket-desktop"));
            candidates.push(home.join(format!(
                "Applications/Sprocket-{}.AppImage",
                env!("CARGO_PKG_VERSION")
            )));
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(root) = std::env::var_os("LOCALAPPDATA") {
            let root = PathBuf::from(root);
            candidates.push(root.join("Programs/Sprocket/sprocket-desktop.exe"));
            candidates.push(root.join("Sprocket/sprocket-desktop.exe"));
        }
        for root in ["PROGRAMFILES", "PROGRAMFILES(X86)"] {
            if let Some(root) = std::env::var_os(root) {
                candidates.push(PathBuf::from(root).join("Sprocket/sprocket-desktop.exe"));
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from(
            "/Applications/Sprocket.app/Contents/MacOS/sprocket-desktop",
        ));
        if let Some(home) = std::env::var_os("HOME") {
            candidates.push(
                PathBuf::from(home)
                    .join("Applications/Sprocket.app/Contents/MacOS/sprocket-desktop"),
            );
        }
    }

    candidates
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
        assert!(desktop.command.is_none());

        let web = Cli::try_parse_from(["sprocket", "--web"]).unwrap();
        assert!(web.web);
        assert!(web.command.is_none());

        let server = Cli::try_parse_from(["sprocket", "serve", "--quiet"]).unwrap();
        assert!(!server.web);
        assert!(matches!(server.command, Some(Commands::Serve(_))));
    }
}
