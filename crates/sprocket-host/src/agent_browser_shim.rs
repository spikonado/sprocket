//! Agents run `agent-browser` through this shim: the `sprocket` executable linked under that
//! name. It adds the Chrome-only launch flag that hides `navigator.webdriver` from bot checks,
//! and leaves it out where agent-browser rejects launch args, such as Firefox.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::sync::OnceLock;

const NAME: &str = "agent-browser";
pub(crate) const REAL_CLI_ENV: &str = "SPROCKET_AGENT_BROWSER";
const LAUNCH_ARGS_ENV: &str = "AGENT_BROWSER_ARGS";
const AUTOMATION_FLAG: &str = "--disable-blink-features=AutomationControlled";

static EXECUTABLE: OnceLock<PathBuf> = OnceLock::new();

/// Runs the shim when this process was started as `agent-browser`. Otherwise records the
/// executable so the host can link the shim to it.
pub fn run_if_invoked() -> Option<ExitCode> {
    let mut args = std::env::args_os();
    let invoked_as = PathBuf::from(args.next()?);
    if invoked_as.file_stem() != Some(OsStr::new(NAME)) {
        if let Ok(executable) = std::env::current_exe() {
            let _ = EXECUTABLE.set(executable);
        }
        return None;
    }
    Some(run(args.collect()))
}

fn run(args: Vec<OsString>) -> ExitCode {
    let Some(cli) = std::env::var_os(REAL_CLI_ENV) else {
        eprintln!("{REAL_CLI_ENV} is not set, so the agent-browser shim can't find agent-browser");
        return ExitCode::from(127);
    };
    let mut command = Command::new(cli);
    command.args(&args);
    if std::env::var_os(LAUNCH_ARGS_ENV).is_none() && launches_chrome(&args, &Environment::read()) {
        command.env(LAUNCH_ARGS_ENV, AUTOMATION_FLAG);
    }
    exec(command)
}

#[cfg(unix)]
fn exec(mut command: Command) -> ExitCode {
    use std::os::unix::process::CommandExt;
    let error = command.exec();
    eprintln!("Could not run agent-browser: {error}");
    ExitCode::from(127)
}

#[cfg(not(unix))]
fn exec(mut command: Command) -> ExitCode {
    match command.status() {
        Ok(status) => ExitCode::from(status.code().map_or(1, |code| code as u8)),
        Err(error) => {
            eprintln!("Could not run agent-browser: {error}");
            ExitCode::from(127)
        }
    }
}

struct Environment {
    engine: Option<OsString>,
    session: Option<OsString>,
    socket_dir: PathBuf,
}

impl Environment {
    fn read() -> Self {
        let non_empty = |name| std::env::var_os(name).filter(|value| !value.is_empty());
        // Mirrors agent-browser's `get_socket_dir`, where each daemon writes `<session>.engine`.
        let socket_dir = match (
            non_empty("AGENT_BROWSER_SOCKET_DIR"),
            non_empty("XDG_RUNTIME_DIR"),
            std::env::home_dir(),
        ) {
            (Some(dir), _, _) => PathBuf::from(dir),
            (None, Some(runtime), _) => Path::new(&runtime).join(NAME),
            (None, None, Some(home)) => home.join(".agent-browser"),
            (None, None, None) => std::env::temp_dir().join(NAME),
        };
        Self {
            engine: non_empty("AGENT_BROWSER_ENGINE"),
            session: non_empty("AGENT_BROWSER_SESSION"),
            socket_dir,
        }
    }
}

/// Whether this command could launch Chrome. Attaching never launches, and Firefox rejects
/// launch args on every command of its session, so its running sessions are looked up too.
fn launches_chrome(args: &[OsString], environment: &Environment) -> bool {
    if args
        .iter()
        .any(|arg| arg == "--cdp" || arg == "--auto-connect" || arg == "connect")
    {
        return false;
    }
    let flag = |name: &str| {
        let index = args.iter().position(|arg| arg == name)?;
        args.get(index + 1).cloned()
    };
    let running_engine = || {
        let mut file = flag("--session")
            .or_else(|| environment.session.clone())
            .unwrap_or_else(|| "default".into());
        file.push(".engine");
        let engine = std::fs::read_to_string(environment.socket_dir.join(file)).ok()?;
        Some(OsString::from(engine.trim()))
    };
    flag("--engine")
        .or_else(|| environment.engine.clone())
        .or_else(running_engine)
        .is_none_or(|engine| engine == "chrome")
}

/// Links `<dir>/agent-browser` to the running `sprocket` executable, replacing an older link.
/// Does nothing when this process isn't the `sprocket` executable, such as in tests.
pub(crate) fn install(dir: &Path) -> std::io::Result<()> {
    let Some(executable) = EXECUTABLE.get() else {
        return Ok(());
    };
    std::fs::create_dir_all(dir)?;
    let staged = dir.join(format!(".{NAME}-{}", std::process::id()));
    let _ = std::fs::remove_file(&staged);
    #[cfg(unix)]
    std::os::unix::fs::symlink(executable, &staged)?;
    #[cfg(not(unix))]
    if std::fs::hard_link(executable, &staged).is_err() {
        std::fs::copy(executable, &staged)?;
    }
    let shim = dir.join(format!("{NAME}{}", std::env::consts::EXE_SUFFIX));
    std::fs::rename(&staged, shim).inspect_err(|_| {
        let _ = std::fs::remove_file(&staged);
    })
}

#[cfg(test)]
mod tests;
