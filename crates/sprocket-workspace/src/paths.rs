use std::path::PathBuf;

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
