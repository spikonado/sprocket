use super::*;

fn connector(data_dir: &Path) -> KiCadConnector {
    KiCadConnector::new(data_dir, Arc::new(PythonTools::new(data_dir).unwrap())).unwrap()
}

#[tokio::test]
async fn keeps_an_older_install_usable_and_updatable_until_uninstalled() {
    let data_dir = tempfile::tempdir().unwrap();
    let connector = connector(data_dir.path());
    let old = connector.root.join("10.99.0-1-gabcdef");
    fs::create_dir_all(old.join("bin")).unwrap();
    fs::write(old.join("bin/kicad-cli"), "old launcher").unwrap();
    fs::write(old.join(USER_KICAD_VERSION_FILE), "11.0.1\n").unwrap();
    fs::create_dir_all(connector.root.join(".staging-interrupted")).unwrap();

    let status = connector.status().await;
    assert_eq!(status.state, ConnectorState::Installed);
    assert!(status.update_available);
    assert_eq!(connector.installed().unwrap().version, "11.0.1");

    repair_unless_installing(&connector.root, &connector.release.version).unwrap();
    assert!(!connector.root.join(".staging-interrupted").exists());
    assert_eq!(
        fs::read_to_string(connector.bin_dir().join("kicad-cli")).unwrap(),
        "old launcher"
    );

    *connector.activity() = Activity::Failed("Download failed".into());
    let status = connector.status().await;
    assert_eq!(status.state, ConnectorState::Installed);
    assert_eq!(status.error.as_deref(), Some("Download failed"));
    assert!(status.update_available);

    connector.uninstall().await.unwrap();
    assert_eq!(connector.status().await.state, ConnectorState::NotInstalled);
    assert!(!connector.bin_dir().exists());
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

#[cfg(unix)]
#[tokio::test]
async fn launchers_run_kicad_and_point_kipy_at_its_cli() {
    let directory = tempfile::tempdir().unwrap();
    let tree = directory.path().join("it's here");
    fs::create_dir_all(&tree).unwrap();
    let (cli, python) = (tree.join("kicad-cli"), tree.join("python"));
    for (program, body) in [
        (&cli, r#"printf '%s|' cli "$@""#),
        (&python, r#"printf '%s|' "$KICAD_CLI_PATH" "$@""#),
    ] {
        fs::write(program, format!("#!/bin/sh\n{body}\n")).unwrap();
        set_executable(program).unwrap();
    }
    let bin = directory.path().join("bin");
    write_launchers(&bin, launchers(&cli, &python))
        .await
        .unwrap();

    let output = |name: &str| {
        let output = std::process::Command::new(bin.join(name))
            .args(["a b", "c"])
            .output()
            .unwrap();
        String::from_utf8(output.stdout).unwrap()
    };
    assert_eq!(output("kicad-cli"), "cli|a b|c|");
    assert_eq!(output("kicad-python"), format!("{}|a b|c|", cli.display()));
}
