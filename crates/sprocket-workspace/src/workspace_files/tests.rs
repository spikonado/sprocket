use super::*;

fn workspace() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("src")).unwrap();
    fs::write(dir.path().join("src/main.rs"), "fn main() {}").unwrap();
    dir
}

#[test]
fn rejects_paths_outside_the_workspace() {
    let dir = workspace();
    let root = dir.path();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret"), "secret").unwrap();

    for path in ["../secret", "src/../../secret", "", "/", "."] {
        assert!(read_workspace_file(root, path).is_err(), "{path:?}");
    }
    let absolute = outside.path().join("secret");
    assert!(read_workspace_file(root, absolute.to_str().unwrap()).is_err());
    assert!(delete_workspace_entry(root, "src/..").is_err());
    assert!(root.join("src/main.rs").exists());
}

#[cfg(unix)]
#[test]
fn rejects_symlink_escapes_but_deletes_the_link_itself() {
    let dir = workspace();
    let root = dir.path();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret"), "secret").unwrap();
    std::os::unix::fs::symlink(outside.path(), root.join("escape")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("secret"), root.join("secret-link")).unwrap();

    assert!(read_workspace_file(root, "escape/secret").is_err());
    assert!(read_workspace_file(root, "secret-link").is_err());
    assert!(create_workspace_entry(root, "escape/new.txt", false).is_err());
    assert!(write_workspace_file(root, "secret-link", "x", None).is_err());

    delete_workspace_entry(root, "escape/").unwrap();
    assert!(!root.join("escape").exists());
    assert!(outside.path().join("secret").exists());
}

#[test]
fn reads_text_and_flags_binary_files() {
    let dir = workspace();
    let root = dir.path();
    fs::write(root.join("blob.bin"), [0u8, 159, 146, 150]).unwrap();

    let text = read_workspace_file(root, "src/main.rs").unwrap();
    assert_eq!(text.content.as_deref(), Some("fn main() {}"));
    assert_eq!(text.unsupported, None);
    let binary = read_workspace_file(root, "blob.bin").unwrap();
    assert_eq!(binary.content, None);
    assert_eq!(binary.unsupported, Some(UnsupportedFile::Binary));
}

#[test]
fn reports_entry_kinds() {
    let dir = workspace();
    let root = dir.path();

    assert_eq!(
        workspace_entry_kind(root, "src").unwrap(),
        WorkspaceEntryKind::Directory
    );
    assert_eq!(
        workspace_entry_kind(root, "src/main.rs").unwrap(),
        WorkspaceEntryKind::File
    );
    assert!(workspace_entry_kind(root, "missing").is_err());
}

#[test]
fn write_detects_conflicts() {
    let dir = workspace();
    let root = dir.path();
    let opened = read_workspace_file(root, "src/main.rs").unwrap();
    fs::write(root.join("src/main.rs"), "changed elsewhere").unwrap();

    let conflict =
        write_workspace_file(root, "src/main.rs", "mine", Some(&opened.version)).unwrap();
    let current = read_workspace_file(root, "src/main.rs").unwrap();
    assert_eq!(
        conflict,
        WorkspaceFileWrite::Conflict {
            version: current.version.clone()
        }
    );
    assert_eq!(current.content.as_deref(), Some("changed elsewhere"));

    let saved = write_workspace_file(root, "src/main.rs", "mine", Some(&current.version)).unwrap();
    let reread = read_workspace_file(root, "src/main.rs").unwrap();
    assert_eq!(
        saved,
        WorkspaceFileWrite::Saved {
            version: reread.version
        }
    );
    assert_eq!(reread.content.as_deref(), Some("mine"));

    assert_eq!(
        write_workspace_file(root, "gone.rs", "x", Some("stale")).unwrap(),
        WorkspaceFileWrite::Conflict {
            version: String::new()
        }
    );
}

#[cfg(unix)]
#[test]
fn write_preserves_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let dir = workspace();
    let script = dir.path().join("run.sh");
    fs::write(&script, "#!/bin/sh").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

    write_workspace_file(dir.path(), "run.sh", "#!/bin/sh\necho", None).unwrap();

    assert_eq!(
        fs::metadata(&script).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

#[test]
fn creates_renames_and_deletes_entries() {
    let dir = workspace();
    let root = dir.path();

    create_workspace_entry(root, "docs/notes/", true).unwrap();
    create_workspace_entry(root, "docs/notes/todo.md", false).unwrap();
    assert!(create_workspace_entry(root, "docs/notes/todo.md", false).is_err());

    rename_workspace_entry(root, "docs/notes/", "archive/notes/").unwrap();
    assert!(root.join("archive/notes/todo.md").is_file());
    assert!(rename_workspace_entry(root, "archive/", "archive/notes/inner").is_err());
    assert!(rename_workspace_entry(root, "src/main.rs", "archive/notes/todo.md").is_err());

    delete_workspace_entry(root, "archive/").unwrap();
    assert!(!root.join("archive").exists());
}
