use std::fs;

use super::*;

fn executable(directory: &Path, relative: &str) -> PathBuf {
    let file = directory.join(relative);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, "").unwrap();
    file
}

#[test]
fn default_finds_git_bash_and_skips_wsl_launchers() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    executable(root, r"Windows\System32\bash.exe");
    executable(root, r"Microsoft\WindowsApps\bash.exe");
    executable(root, r"Git\cmd\git.exe");
    let git_bash = executable(root, r"Git\bin\bash.exe");
    let path = std::env::join_paths([
        root.join(r"Windows\System32"),
        root.join(r"Microsoft\WindowsApps"),
        root.join(r"Git\cmd"),
    ])
    .unwrap();
    assert_eq!(
        default_shell(Some(path.as_os_str())),
        git_bash.to_string_lossy()
    );
    assert_eq!(
        resolve_shell("bash", Some(path.as_os_str())),
        git_bash.to_string_lossy()
    );
}

#[test]
fn default_falls_back_to_powershell_without_bash() {
    let directory = tempfile::tempdir().unwrap();
    executable(directory.path(), r"System32\bash.exe");
    let path = directory.path().join("System32");
    assert_eq!(default_shell(Some(path.as_os_str())), "powershell.exe");
    assert_eq!(default_shell(None), "powershell.exe");
}
