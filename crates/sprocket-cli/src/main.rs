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

            anyhow::bail!(
                "Sprocket desktop app was not found. Install it alongside the CLI, or set \
                 {DESKTOP_EXECUTABLE_ENV} to its executable path. Use `sprocket --web` to launch \
                 the browser app without the desktop app."
            )
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
        Err(error) if error.is_connect() => return Ok(false),
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
    open::that(&target)
        .with_context(|| format!("failed to open the browser; open {target} manually"))?;
    Ok(true)
}

fn launch_desktop(workspace_path: Option<&str>) -> anyhow::Result<bool> {
    let desktop_executable = std::env::var_os(DESKTOP_EXECUTABLE_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            installed_desktop_candidates()
                .into_iter()
                .find(|candidate| candidate.is_file())
        });

    if let Some(target) = desktop_executable {
        spawn_desktop(Command::new(&target), workspace_path)
            .with_context(|| format!("failed to launch {}", target.display()))?;
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
            candidates.extend(linux_appimage_candidates(&home));
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

#[cfg(target_os = "linux")]
fn linux_appimage_candidates(home: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(home.join("Applications")) else {
        return Vec::new();
    };
    let electron_arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    let mut candidates = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    is_sprocket_appimage_name(name) && appimage_matches_arch(name, electron_arch)
                })
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        let left_name = left
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        let right_name = right
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        // Prefer an exact CLI version match, then newer embedded versions.
        u8::from(appimage_matches_version(right_name))
            .cmp(&u8::from(appimage_matches_version(left_name)))
            .then_with(|| appimage_version_key(right_name).cmp(&appimage_version_key(left_name)))
            .then_with(|| left_name.cmp(right_name))
    });
    candidates
}

#[cfg(target_os = "linux")]
fn is_sprocket_appimage_name(name: &str) -> bool {
    name.ends_with(".AppImage")
        && (name.starts_with("sprocket-desktop-") || name.starts_with("Sprocket-"))
}

#[cfg(target_os = "linux")]
fn appimage_matches_version(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".AppImage") else {
        return false;
    };
    let Some(rest) = stem
        .strip_prefix("sprocket-desktop-")
        .or_else(|| stem.strip_prefix("Sprocket-"))
    else {
        return false;
    };
    if rest == VERSION {
        return true;
    }
    rest.strip_prefix(VERSION)
        .is_some_and(|suffix| suffix.starts_with('-') && !suffix[1..].contains('.'))
}

#[cfg(target_os = "linux")]
fn appimage_matches_arch(name: &str, electron_arch: &str) -> bool {
    let Some(stem) = name.strip_suffix(".AppImage") else {
        return false;
    };
    if stem.ends_with(&format!("-{electron_arch}")) {
        return true;
    }
    // Arch-agnostic names (no -x64/-arm64 suffix) are acceptable on any host.
    !stem.ends_with("-x64") && !stem.ends_with("-arm64") && !stem.ends_with("-ia32")
}

#[cfg(target_os = "linux")]
fn appimage_embedded_version(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".AppImage")?;
    let rest = stem
        .strip_prefix("sprocket-desktop-")
        .or_else(|| stem.strip_prefix("Sprocket-"))?;
    let rest = rest
        .strip_suffix("-x64")
        .or_else(|| rest.strip_suffix("-arm64"))
        .or_else(|| rest.strip_suffix("-ia32"))
        .unwrap_or(rest);
    Some(
        rest.strip_suffix("-linux")
            .or_else(|| rest.strip_suffix("-mac"))
            .or_else(|| rest.strip_suffix("-win"))
            .unwrap_or(rest),
    )
}

#[cfg(target_os = "linux")]
fn appimage_version_key(name: &str) -> (u64, u64, u64, bool, &str) {
    let Some(version) = appimage_embedded_version(name) else {
        return (0, 0, 0, false, "");
    };
    let (core, prerelease) = match version.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (version, None),
    };
    let mut parts = core.split('.');
    let major = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    let patch = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    (
        major,
        minor,
        patch,
        prerelease.is_none(),
        prerelease.unwrap_or(""),
    )
}

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

    #[cfg(target_os = "linux")]
    #[test]
    fn discovers_versioned_and_arch_appimages() {
        let temp =
            std::env::temp_dir().join(format!("sprocket-appimage-candidates-{}", Uuid::new_v4()));
        let applications = temp.join("Applications");
        std::fs::create_dir_all(&applications).unwrap();
        let host_arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => other,
        };
        let other_arch = if host_arch == "x64" { "arm64" } else { "x64" };
        let matching = applications.join(format!(
            "sprocket-desktop-{VERSION}-linux-{host_arch}.AppImage"
        ));
        let wrong_arch = applications.join(format!(
            "sprocket-desktop-{VERSION}-linux-{other_arch}.AppImage"
        ));
        let other_version =
            applications.join(format!("sprocket-desktop-9.9.9-linux-{host_arch}.AppImage"));
        let canary_collision = applications.join(format!(
            "sprocket-desktop-{VERSION}-canary.1-linux-{host_arch}.AppImage"
        ));
        for path in [&matching, &wrong_arch, &other_version, &canary_collision] {
            std::fs::write(path, []).unwrap();
        }

        let candidates = linux_appimage_candidates(&temp);
        assert_eq!(candidates, [matching, other_version, canary_collision]);
        assert!(!candidates.contains(&wrong_arch));
        assert!(appimage_matches_version(&format!(
            "sprocket-desktop-{VERSION}-linux-{host_arch}.AppImage"
        )));
        assert!(!appimage_matches_version(&format!(
            "sprocket-desktop-{VERSION}-canary.1-linux-{host_arch}.AppImage"
        )));
        assert!(appimage_matches_arch(
            &format!("sprocket-desktop-{VERSION}-linux-{host_arch}.AppImage"),
            host_arch
        ));
        assert!(!appimage_matches_arch(
            &format!("sprocket-desktop-{VERSION}-linux-{other_arch}.AppImage"),
            host_arch
        ));

        std::fs::remove_dir_all(&temp).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn ignores_wrong_architecture_only_appimages() {
        let temp = std::env::temp_dir().join(format!(
            "sprocket-appimage-wrong-arch-only-{}",
            Uuid::new_v4()
        ));
        let applications = temp.join("Applications");
        std::fs::create_dir_all(&applications).unwrap();
        let other_arch = match std::env::consts::ARCH {
            "x86_64" => "arm64",
            _ => "x64",
        };
        std::fs::write(
            applications.join(format!(
                "sprocket-desktop-{VERSION}-linux-{other_arch}.AppImage"
            )),
            [],
        )
        .unwrap();

        assert!(linux_appimage_candidates(&temp).is_empty());
        std::fs::remove_dir_all(&temp).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn prefers_newer_appimage_when_version_does_not_match() {
        let temp = std::env::temp_dir().join(format!(
            "sprocket-appimage-newer-fallback-{}",
            Uuid::new_v4()
        ));
        let applications = temp.join("Applications");
        std::fs::create_dir_all(&applications).unwrap();
        let host_arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => other,
        };
        let older = applications.join(format!("sprocket-desktop-1.0.0-linux-{host_arch}.AppImage"));
        let newer = applications.join(format!("sprocket-desktop-2.0.0-linux-{host_arch}.AppImage"));
        for path in [&newer, &older] {
            std::fs::write(path, []).unwrap();
        }

        assert_eq!(linux_appimage_candidates(&temp), [newer, older]);
        std::fs::remove_dir_all(&temp).unwrap();
    }
}
