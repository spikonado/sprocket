use super::*;

#[test]
fn run_requires_one_explicit_prompt_source() {
    assert!(Cli::try_parse_from(["tinker", "run"]).is_err());
    assert!(Cli::try_parse_from(["tinker", "run", "task", "--prompt-file", "task.md"]).is_err());
    assert!(Cli::try_parse_from(["tinker", "run", "--prompt-file", "-"]).is_ok());
    assert!(Cli::try_parse_from(["tinker", "run", "task", "--directory", "."]).is_ok());
    let list_models = Cli::try_parse_from(["tinker", "run", "--list-models"]).unwrap();
    assert!(matches!(
        list_models.command,
        Some(Commands::Run(commands::RunArgs {
            prompt: None,
            list_models: true,
            ..
        }))
    ));
    assert!(Cli::try_parse_from(["tinker", "run", "task", "--list-models"]).is_err());
    assert!(Cli::try_parse_from(["tinker", "run", "task", "--json"]).is_err());
    assert!(Cli::try_parse_from(["tinker", "run", "task", "--stream-json"]).is_err());
    assert!(Cli::try_parse_from(["tinker", "run", "task", "--fast", "--no-fast"]).is_err());
}

#[test]
fn parses_launch_server_and_update_modes() {
    let desktop = Cli::try_parse_from(["tinker"]).unwrap();
    assert!(!desktop.web);
    assert!(desktop.directory.is_none());
    assert!(desktop.command.is_none());

    let web = Cli::try_parse_from(["tinker", "--web", "./robot"]).unwrap();
    assert!(web.web);
    assert_eq!(web.directory, Some(PathBuf::from("./robot")));
    assert!(web.command.is_none());

    let workspace = Cli::try_parse_from(["tinker", "/tmp/robot"]).unwrap();
    assert_eq!(workspace.directory, Some(PathBuf::from("/tmp/robot")));
    assert!(workspace.command.is_none());

    let server = Cli::try_parse_from(["tinker", "serve", "--quiet"]).unwrap();
    assert!(!server.web);
    assert!(server.directory.is_none());
    assert!(matches!(server.command, Some(Commands::Serve(_))));

    let update = Cli::try_parse_from(["tinker", "upgrade", "--check"]).unwrap();
    assert!(matches!(
        update.command,
        Some(Commands::Update(UpdateArgs { check: true }))
    ));
}
