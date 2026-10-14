use std::fs;

use super::*;

fn temp_dir(name: &str) -> PathBuf {
    crate::test_support::temp_workspace_labeled(name)
}

#[test]
fn lists_child_directories() {
    let root = temp_dir("sprocket-browse-root");
    let child = root.join("child-a");
    fs::create_dir_all(&child).expect("child dir");

    let result = browse_filesystem(&root.to_string_lossy(), None).expect("browse");
    let names: Vec<String> = result
        .entries
        .iter()
        .map(|entry| entry.name.clone())
        .collect();

    assert!(names.contains(&"..".to_string()));
    assert!(names.contains(&"child-a".to_string()));

    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn resolves_nonexistent_leaf_against_existing_parent() {
    let root = temp_dir("sprocket-browse-parent");
    let partial = root.join("new-project").to_string_lossy().to_string();

    let result = browse_filesystem(&partial, None).expect("browse");
    assert_eq!(result.parent_path, root.to_string_lossy());

    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn listing_succeeds_when_a_child_cannot_be_resolved() {
    let root = temp_dir("sprocket-browse-mixed");
    fs::create_dir(root.join("visible")).expect("visible dir");
    fs::write(root.join("notes.txt"), "hi").expect("file");

    #[cfg(unix)]
    std::os::unix::fs::symlink("missing", root.join("broken")).expect("dangling symlink");

    let result = browse_filesystem(&root.to_string_lossy(), None).expect("browse");
    let names: Vec<&str> = result
        .entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();

    assert!(names.contains(&"visible"));
    assert!(!names.contains(&"notes.txt"));
    #[cfg(unix)]
    assert!(!names.contains(&"broken"));

    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn filesystem_root_can_be_browsed() {
    let result = browse_filesystem("/", None).expect("browse root");
    assert!(!result.entries.is_empty());
    assert!(!result.entries.iter().any(|entry| entry.name == ".."));
}

#[test]
fn parses_windows_logical_drive_mask() {
    assert_eq!(drive_letters_from_mask(0b1101), vec!['A', 'C', 'D']);
}

#[test]
fn detects_windows_volume_list_query() {
    assert!(is_windows_volume_list_query("/"));
    assert!(is_windows_volume_list_query("\\"));
    assert!(!is_windows_volume_list_query("//server/share"));
    assert!(!is_windows_volume_list_query(r"D:\"));
}
