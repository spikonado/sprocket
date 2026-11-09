use super::*;

fn connector(data_dir: &Path) -> KiCadConnector {
    KiCadConnector::new(data_dir, Arc::new(PythonTools::new(data_dir).unwrap())).unwrap()
}

#[tokio::test]
async fn keeps_an_older_install_usable_and_updatable_until_uninstalled() {
    let data_dir = tempfile::tempdir().unwrap();
    let connector = connector(data_dir.path());
    let old = connector.root.join("v0.0.1");
    fs::create_dir_all(old.join("bin")).unwrap();
    fs::write(old.join("bin/kicad-cli"), "old launcher").unwrap();
    fs::write(old.join(KICAD_VERSION_FILE), "11.0.1\n").unwrap();
    fs::write(old.join(LIBRARIES_FILE), "/kicad/share\n").unwrap();
    fs::write(old.join(KIPY_API_FILE), "old script").unwrap();
    fs::create_dir_all(old.join(ROUTING_TOOLS_DIR)).unwrap();
    fs::create_dir_all(connector.root.join(".staging-interrupted")).unwrap();

    let status = connector.status().await;
    assert_eq!(status.state, ConnectorState::Installed);
    assert!(status.update_available);
    assert_eq!(
        connector.installed().unwrap(),
        "KiCad connector v0.0.1 (KiCad 11.0.1)"
    );
    assert_eq!(
        connector.environment(),
        vec![
            (
                OsString::from(LIBRARIES_VARIABLE),
                OsString::from("/kicad/share")
            ),
            (
                OsString::from(ROUTING_TOOLS_VARIABLE),
                old.join(ROUTING_TOOLS_DIR).into_os_string()
            ),
        ]
    );

    repair_unless_installing(&connector.root, &connector.pinned).unwrap();
    assert!(!connector.root.join(".staging-interrupted").exists());
    assert_eq!(
        fs::read_to_string(connector.bin_dir().join("kicad-cli")).unwrap(),
        "old launcher"
    );
    assert_eq!(
        fs::read_to_string(old.join(KIPY_API_FILE)).unwrap(),
        KIPY_API
    );

    *connector.activity() = Activity::Installing;
    let status = connector.status().await;
    assert_eq!(status.state, ConnectorState::Installing);
    assert!(status.update_available);

    *connector.activity() = Activity::Failed("Download failed".into());
    let status = connector.status().await;
    assert_eq!(status.state, ConnectorState::Installed);
    assert_eq!(status.error.as_deref(), Some("Download failed"));
    assert!(status.update_available);

    connector.lease("v0.0.1");
    fs::create_dir_all(connector.version_dir()).unwrap();
    prune_versions(&connector.root, &connector.pinned);
    assert!(old.is_dir());

    connector.uninstall().await.unwrap();
    assert_eq!(connector.status().await.state, ConnectorState::NotInstalled);
    assert!(!connector.bin_dir().exists());
}

#[tokio::test]
async fn uninstall_keeps_an_install_queued_behind_its_lock() {
    let data_dir = tempfile::tempdir().unwrap();
    let connector = connector(data_dir.path());
    fs::create_dir_all(&connector.root).unwrap();
    let held = acquire_lock(connector.root.join(INSTALL_LOCK))
        .await
        .unwrap();
    let uninstall = connector.uninstall();
    tokio::pin!(uninstall);
    assert!(
        tokio::time::timeout(Duration::from_millis(300), &mut uninstall)
            .await
            .is_err()
    );
    *connector.activity() = Activity::Installing;
    drop(held);
    uninstall.await.unwrap();
    assert_eq!(connector.status().await.state, ConnectorState::Installing);
}

#[test]
fn reads_kicad_versions() {
    assert_eq!(major_minor("10.99.0-6189-g113c71d59d"), Some((10, 99)));
    assert_eq!(major_minor("(9.0.2)"), Some((9, 0)));
}

#[test]
fn copies_only_missing_lib_tables() {
    let directory = tempfile::tempdir().unwrap();
    let (template, config) = (
        directory.path().join("template"),
        directory.path().join("config"),
    );
    fs::create_dir_all(&template).unwrap();
    fs::create_dir_all(&config).unwrap();
    fs::write(template.join("fp-lib-table"), "template fp").unwrap();
    fs::write(template.join("sym-lib-table"), "template sym").unwrap();
    fs::write(config.join("sym-lib-table"), "user sym").unwrap();

    copy_lib_tables(&template, &config).unwrap();

    assert_eq!(
        fs::read_to_string(config.join("fp-lib-table")).unwrap(),
        "template fp"
    );
    assert_eq!(
        fs::read_to_string(config.join("sym-lib-table")).unwrap(),
        "user sym"
    );
}

#[test]
fn fontconfig_keeps_the_hosts_font_dirs_and_rules_it_can_read() {
    let host = tempfile::tempdir().unwrap();
    let conf_d = host.path().join("conf.d");
    fs::create_dir(&conf_d).unwrap();
    let fonts_conf = |includes: &str| {
        format!(
            "<fontconfig>\n\t<dir>/usr/share/fonts</dir>\n\t{includes}\n\t<include ignore_missing=\"yes\">local.conf</include>\n</fontconfig>\n"
        )
    };
    fs::write(
        host.path().join("fonts.conf"),
        fonts_conf("<include ignore_missing=\"yes\">conf.d</include>"),
    )
    .unwrap();
    for (name, contents) in [
        ("00-cache.conf", "<dir>/nix/store/fonts</dir>"),
        ("48-guessfamily.conf", "<edit name=\"genericfamily\"/>"),
        ("60-latin.conf", "<alias/>"),
        ("README", "<dir>/ignored</dir>"),
    ] {
        fs::write(conf_d.join(name), contents).unwrap();
    }

    assert_eq!(
        host_fontconfig(host.path()),
        fonts_conf(&format!(
            "<include ignore_missing=\"yes\">{}</include>\n<include ignore_missing=\"yes\">{}</include>",
            conf_d.join("00-cache.conf").display(),
            conf_d.join("60-latin.conf").display()
        ))
    );
}

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
    write_launchers(
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
