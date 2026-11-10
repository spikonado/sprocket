use std::fs;

use super::*;
use crate::tool_install::set_executable;

#[cfg(unix)]
#[tokio::test]
async fn launchers_run_kicad_and_point_kipy_and_the_routing_tools_at_its_cli() {
    let directory = tempfile::tempdir().unwrap();
    let tree = directory.path().join("it's here");
    fs::create_dir_all(&tree).unwrap();
    let (cli, python, kipy_api, kicad_view) = (
        tree.join("kicad-cli"),
        tree.join("python"),
        tree.join("kipy-api.py"),
        tree.join("kicad-view.py"),
    );
    for (program, body) in [
        (&cli, r#"printf '%s|' cli "$FONTCONFIG_FILE" "$@""#),
        (
            &python,
            r#"printf '%s|' "$KICAD_CLI_PATH$KICAD_CLI" "$SPROCKET_KICAD_ROUTING_TOOLS" "$@""#,
        ),
    ] {
        fs::write(program, format!("#!/bin/sh\n{body}\n")).unwrap();
        set_executable(program).unwrap();
    }
    let bin = directory.path().join("bin");
    let fonts_conf = tree.join("fonts.conf");
    write(
        &bin,
        launchers(
            &cli,
            &python,
            &kipy_api,
            &kicad_view,
            Some(&tree),
            Some(&fonts_conf),
        ),
    )
    .await
    .unwrap();

    let output = |name: &str| {
        let output = std::process::Command::new(bin.join(name))
            .args(["a b", "c"])
            .output()
            .unwrap();
        String::from_utf8(output.stdout).unwrap()
    };
    assert_eq!(
        output("kicad-cli"),
        format!("cli|{}|a b|c|", fonts_conf.display())
    );
    assert_eq!(output("kicad-python"), format!("{}||a b|c|", cli.display()));
    assert_eq!(
        output("kipy-api"),
        format!("||{}|a b|c|", kipy_api.display())
    );
    assert_eq!(
        output("kicad-route"),
        format!(
            "{}||{}|a b|c|",
            cli.display(),
            route_script(&tree).display()
        )
    );
    assert_eq!(
        output("kicad-view"),
        format!(
            "{}|{}|{}|a b|c|",
            cli.display(),
            tree.display(),
            kicad_view.display()
        )
    );
}
