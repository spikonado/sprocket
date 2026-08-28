use std::path::{Path, PathBuf};

pub fn expand_home(path: &str) -> String {
    if path == "~" {
        return home_dir()
            .map(|home| home.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());
    }

    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return format!("{}/{}", home.to_string_lossy(), rest);
        }
    }

    if let Some(rest) = path.strip_prefix("~\\") {
        if let Some(home) = home_dir() {
            return format!("{}\\{}", home.to_string_lossy(), rest);
        }
    }

    path.to_string()
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

pub fn normalize_windows_drive_root(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        format!("{path}\\")
    } else {
        path.to_string()
    }
}

/// Strips Windows `\\?\` drive and UNC prefixes so paths are usable in the UI.
pub fn simplified_path(path: impl AsRef<Path>) -> PathBuf {
    PathBuf::from(simplified_path_str(&path.as_ref().to_string_lossy()))
}

fn simplified_path_str(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        if rest.len() >= 2 && rest.as_bytes()[0].is_ascii_alphabetic() && rest.as_bytes()[1] == b':'
        {
            rest.to_string()
        } else {
            path.to_string()
        }
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(normalize_windows_drive_root("D:"), r"D:\");
        assert_eq!(normalize_windows_drive_root(r"D:\code"), r"D:\code");
        assert_eq!(normalize_windows_drive_root("/home/me"), "/home/me");
    }
}
