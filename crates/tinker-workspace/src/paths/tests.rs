use super::*;

#[test]
fn expand_home_with_replaces_a_leading_tilde() {
    let home = Path::new("/home/me");
    assert_eq!(expand_home_with("~", Some(home)), "/home/me");
    assert_eq!(expand_home_with("~/robot", Some(home)), "/home/me/robot");
    assert_eq!(expand_home_with(r"~\robot", Some(home)), r"/home/me\robot");
    assert_eq!(expand_home_with("~robot", Some(home)), "~robot");
    assert_eq!(expand_home_with("src/~/robot", Some(home)), "src/~/robot");
    assert_eq!(expand_home_with("~/robot", None), "~/robot");
}

#[test]
fn simplified_path_strips_windows_verbatim_prefixes() {
    assert_eq!(
        simplified_path_str(r"\\?\D:\projects\robot"),
        r"D:\projects\robot"
    );
    assert_eq!(
        simplified_path_str(r"\\?\UNC\server\share\dir"),
        r"\\server\share\dir"
    );
    assert_eq!(
        simplified_path_str(r"\\?\Volume{abcd}\foo"),
        r"\\?\Volume{abcd}\foo"
    );
    assert_eq!(simplified_path_str("/home/me/robot"), "/home/me/robot");
}

#[test]
fn normalize_windows_drive_root_appends_slash() {
    for path in ["D:", "e:"] {
        assert_eq!(normalize_windows_drive_root(path), format!(r"{path}\"));
    }
    assert_eq!(normalize_windows_drive_root(r"D:\"), r"D:\");
    assert_eq!(normalize_windows_drive_root("E:/"), "E:/");
    assert_eq!(normalize_windows_drive_root(r"D:\code"), r"D:\code");
    assert_eq!(normalize_windows_drive_root("D:code"), "D:code");
    assert_eq!(normalize_windows_drive_root("/home/me"), "/home/me");
}
