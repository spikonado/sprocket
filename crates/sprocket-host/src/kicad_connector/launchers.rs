use std::io;
use std::path::{Path, PathBuf};

use crate::tool_install::set_executable;

/// `kicad-python` points kipy at this KiCad, since kipy would otherwise prefer a system
/// install over `PATH`, and `kicad-route` and `kicad-view` do the same for KiCadRoutingTools.
/// Windows also gets `.cmd` launchers, while Git Bash, agents' usual shell there, only runs
/// the `sh` ones.
pub(super) fn launchers(
    cli: &Path,
    python: &Path,
    kipy_api: &Path,
    kicad_view: &Path,
    routing_tools: Option<&Path>,
    fonts_conf: Option<&Path>,
) -> Vec<(&'static str, String)> {
    let quote = |path: &Path| format!("'{}'", path.display().to_string().replace('\'', r"'\''"));
    let environment = fonts_conf
        .map(|file| format!("export FONTCONFIG_FILE={}\n", quote(file)))
        .unwrap_or_default();
    let script = |body: String| format!("#!/bin/sh\n{environment}{body}\n");
    let gui = if cfg!(target_os = "macos") {
        let app = cli.ancestors().nth(3).unwrap_or(cli);
        format!("exec open -a {} \"$@\"", quote(app))
    } else {
        let executable = cli.with_file_name(format!("kicad{}", std::env::consts::EXE_SUFFIX));
        format!("exec {} \"$@\"", quote(executable.as_path()))
    };
    let mut launchers = vec![
        ("kicad", script(gui)),
        ("kicad-cli", script(format!("exec {} \"$@\"", quote(cli)))),
        (
            "kicad-python",
            script(format!(
                "export KICAD_CLI_PATH={}\nexec {} \"$@\"",
                quote(cli),
                quote(python)
            )),
        ),
        (
            "kipy-api",
            script(format!("exec {} {} \"$@\"", quote(python), quote(kipy_api))),
        ),
    ];
    if let Some(tools) = routing_tools {
        launchers.push((
            "kicad-route",
            script(format!(
                "export KICAD_CLI={}\nexec {} {} \"$@\"",
                quote(cli),
                quote(python),
                quote(&route_script(tools))
            )),
        ));
        launchers.push((
            "kicad-view",
            script(format!(
                "export KICAD_CLI={}\nexport SPROCKET_KICAD_ROUTING_TOOLS={}\nexec {} {} \"$@\"",
                quote(cli),
                quote(tools),
                quote(python),
                quote(kicad_view)
            )),
        ));
    }
    #[cfg(windows)]
    launchers.extend(cmd_launchers(
        cli,
        python,
        kipy_api,
        kicad_view,
        routing_tools,
    ));
    launchers
}

fn route_script(routing_tools: &Path) -> PathBuf {
    routing_tools.join("py_router").join("route.py")
}

#[cfg(windows)]
fn cmd_launchers(
    cli: &Path,
    python: &Path,
    kipy_api: &Path,
    kicad_view: &Path,
    routing_tools: Option<&Path>,
) -> Vec<(&'static str, String)> {
    let escape = |path: &Path| path.display().to_string().replace('%', "%%");
    let quote = |path: &Path| format!("\"{}\"", escape(path));
    let script = |setup: String, command: String| -> String {
        format!("@echo off\r\nsetlocal\r\n{setup}{command} %*\r\nexit /b %ERRORLEVEL%\r\n")
    };
    let mut launchers = vec![
        (
            "kicad.cmd",
            script(String::new(), quote(&cli.with_file_name("kicad.exe"))),
        ),
        ("kicad-cli.cmd", script(String::new(), quote(cli))),
        (
            "kicad-python.cmd",
            script(
                format!("set \"KICAD_CLI_PATH={}\"\r\n", escape(cli)),
                quote(python),
            ),
        ),
        (
            "kipy-api.cmd",
            script(
                String::new(),
                format!("{} {}", quote(python), quote(kipy_api)),
            ),
        ),
    ];
    if let Some(tools) = routing_tools {
        launchers.push((
            "kicad-route.cmd",
            script(
                format!("set \"KICAD_CLI={}\"\r\n", escape(cli)),
                format!("{} {}", quote(python), quote(&route_script(tools))),
            ),
        ));
        launchers.push((
            "kicad-view.cmd",
            script(
                format!(
                    "set \"KICAD_CLI={}\"\r\nset \"SPROCKET_KICAD_ROUTING_TOOLS={}\"\r\n",
                    escape(cli),
                    escape(tools)
                ),
                format!("{} {}", quote(python), quote(kicad_view)),
            ),
        ));
    }
    launchers
}

pub(super) async fn write(bin: &Path, launchers: Vec<(&'static str, String)>) -> io::Result<()> {
    tokio::fs::create_dir_all(bin).await?;
    for (name, contents) in launchers {
        let path = bin.join(name);
        tokio::fs::write(&path, contents).await?;
        set_executable(&path)?;
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests;
