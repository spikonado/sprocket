use std::path::{Path, PathBuf};

/// Relative path from the install prefix where the built web app lives.
pub const INSTALLED_WEB_DIR: &str = "share/sprocket/web";

/// Compile-time override for packagers, e.g.
/// `SPROCKET_SHARE_DIR=/usr/share/sprocket/web cargo build --release`.
const COMPILE_TIME_SHARE_DIR: Option<&str> = option_env!("SPROCKET_SHARE_DIR");

pub fn is_valid_static_dir(path: &Path) -> bool {
    path.join("index.html").is_file()
}

/// Resolve the web app directory using, in order:
/// 1. Explicit override (`--static-dir` / `SPROCKET_STATIC_DIR`)
/// 2. Compile-time `SPROCKET_SHARE_DIR`
/// 3. Installed layout next to the running binary
/// 4. Local development layout when running from a checkout
pub fn resolve_static_dir(override_path: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(path) = override_path.filter(|path| is_valid_static_dir(path)) {
        return Some(path);
    }

    if let Some(path) = compile_time_share_dir().filter(|path| is_valid_static_dir(path)) {
        return Some(path);
    }

    if let Some(path) = discover_installed_static_dir().filter(|path| is_valid_static_dir(path)) {
        return Some(path);
    }

    discover_dev_static_dir().filter(|path| is_valid_static_dir(path))
}

fn compile_time_share_dir() -> Option<PathBuf> {
    COMPILE_TIME_SHARE_DIR.map(PathBuf::from)
}

fn discover_installed_static_dir() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();

    for candidate in installed_static_candidates(&exe_dir) {
        if candidate.is_dir() {
            return candidate.canonicalize().ok();
        }
    }

    None
}

fn installed_static_candidates(exe_dir: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(prefix) = exe_dir.parent() {
        candidates.push(prefix.join(INSTALLED_WEB_DIR));
    }

    candidates.push(exe_dir.join("web/dist"));
    candidates
}

fn discover_dev_static_dir() -> Option<PathBuf> {
    find_dev_static_dir_from(Path::new(".")).or_else(|| {
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .and_then(|dir| find_dev_static_dir_from(&dir))
    })
}

fn find_dev_static_dir_from(start: &Path) -> Option<PathBuf> {
    let start = start.canonicalize().ok()?;

    for offset in 0..=4 {
        let mut root = start.clone();
        for _ in 0..offset {
            root = root.parent()?.to_path_buf();
        }

        for candidate in [root.join("apps/web/dist"), root.join("web/dist")] {
            if candidate.is_dir() {
                return candidate.canonicalize().ok();
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_explicit_static_dir_override() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let expected = manifest_dir.join("../../apps/web/dist");

        if !expected.join("index.html").exists() {
            return;
        }

        let resolved = resolve_static_dir(Some(expected.canonicalize().unwrap())).unwrap();
        assert!(is_valid_static_dir(&resolved));
    }

    #[test]
    fn discovers_dev_static_dir_from_repo_root() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest_dir
            .join("../..")
            .canonicalize()
            .expect("repo root");
        let expected = repo_root.join("apps/web/dist");

        if !expected.join("index.html").exists() {
            return;
        }

        assert_eq!(
            find_dev_static_dir_from(&repo_root),
            expected.canonicalize().ok()
        );
    }

    #[test]
    fn installed_candidates_include_fhs_and_cli_bundle_layouts() {
        let exe_dir = PathBuf::from("/usr/bin");
        let candidates = installed_static_candidates(&exe_dir);

        assert!(candidates.contains(&PathBuf::from("/usr/share/sprocket/web")));
        assert!(candidates.contains(&PathBuf::from("/usr/bin/web/dist")));
    }
}
