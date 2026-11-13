use super::*;

#[test]
fn run_requires_one_explicit_prompt_source() {
    assert!(Cli::try_parse_from(["sprocket", "run"]).is_err());
    assert!(Cli::try_parse_from(["sprocket", "run", "task", "--prompt-file", "task.md"]).is_err());
    assert!(Cli::try_parse_from(["sprocket", "run", "--prompt-file", "-"]).is_ok());
    assert!(Cli::try_parse_from(["sprocket", "run", "task", "--directory", "."]).is_ok());
    let list_models = Cli::try_parse_from(["sprocket", "run", "--list-models"]).unwrap();
    assert!(matches!(
        list_models.command,
        Some(Commands::Run(commands::RunArgs {
            prompt: None,
            list_models: true,
            ..
        }))
    ));
    assert!(Cli::try_parse_from(["sprocket", "run", "task", "--list-models"]).is_err());
    assert!(Cli::try_parse_from(["sprocket", "run", "task", "--json"]).is_err());
    assert!(Cli::try_parse_from(["sprocket", "run", "task", "--stream-json"]).is_err());
    assert!(Cli::try_parse_from(["sprocket", "run", "task", "--fast", "--no-fast"]).is_err());
}

#[test]
fn service_tier_choices_conflict_with_legacy_fast_flags() {
    for tier in ["standard", "fast", "ultrafast"] {
        assert!(Cli::try_parse_from(["sprocket", "run", "task", "--service-tier", tier]).is_ok());
        for flag in ["--fast", "--no-fast"] {
            assert!(
                Cli::try_parse_from(["sprocket", "run", "task", "--service-tier", tier, flag])
                    .is_err()
            );
        }
    }
    assert!(
        Cli::try_parse_from(["sprocket", "run", "task", "--service-tier", "priority"]).is_err()
    );
}

#[test]
fn parses_launch_server_and_update_modes() {
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

    let update = Cli::try_parse_from(["sprocket", "upgrade", "--check"]).unwrap();
    assert!(matches!(
        update.command,
        Some(Commands::Update(UpdateArgs { check: true }))
    ));
}

#[test]
fn reads_the_desktop_executable_recorded_in_the_data_dir() {
    let data_dir = std::env::temp_dir().join(format!("sprocket-cli-test-{}", Uuid::new_v4()));
    std::fs::create_dir(&data_dir).unwrap();
    assert_eq!(recorded_desktop_executable(&data_dir), None);

    let executable = std::env::temp_dir()
        .join("Sprocket Apps")
        .join("sprocket-desktop");
    std::fs::write(
        data_dir.join(DESKTOP_EXECUTABLE_FILE),
        format!("{}\n", executable.display()),
    )
    .unwrap();
    let recorded = recorded_desktop_executable(&data_dir);
    std::fs::remove_dir_all(&data_dir).unwrap();
    assert_eq!(recorded, Some(executable));
}
