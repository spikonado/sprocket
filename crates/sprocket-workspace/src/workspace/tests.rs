use super::*;

#[test]
fn windows_workspace_spellings_resolve_to_the_same_display_path() {
    let root = crate::test_support::temp_workspace_labeled("sprocket-resolve-windows");
    let expected = crate::paths::simplified_path(&root);
    let displayed = expected.to_string_lossy();

    for query in [
        root.to_string_lossy().into_owned(),
        displayed.to_string(),
        displayed.replace('\\', "/"),
    ] {
        assert_eq!(resolve_workspace_root(&query).expect("resolve"), expected);
    }

    std::fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn bare_windows_drive_resolves_to_the_root_not_a_drive_current_directory() {
    let workspace = crate::test_support::temp_workspace_labeled("sprocket-resolve-drive");
    let root = workspace.ancestors().last().expect("drive root");
    let expected = crate::paths::simplified_path(root);
    let displayed = expected.to_string_lossy();
    let bare_drive = displayed.trim_end_matches('\\');

    assert_eq!(
        resolve_workspace_root(bare_drive).expect("resolve"),
        expected
    );

    std::fs::remove_dir_all(workspace).expect("cleanup");
}
