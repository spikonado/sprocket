use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

const MAX_INSTRUCTION_BYTES: usize = 32 * 1024;
const WORKSPACE_INSTRUCTION_FILES: [&str; 2] = ["AGENTS.override.md", "AGENTS.md"];
const PROJECT_ROOT_MARKERS: [&str; 1] = [".git"];

#[derive(Debug, Clone)]
pub struct WorkspaceInstruction {
    pub path: String,
    pub directory: String,
    pub contents: String,
    pub truncated: bool,
}

pub fn load_workspace_instructions(cwd: &Path) -> Result<Vec<WorkspaceInstruction>> {
    let canonical_cwd = cwd
        .canonicalize()
        .with_context(|| format!("failed to resolve {}", cwd.display()))?;
    let project_root = find_project_root(&canonical_cwd);
    let search_dirs = directories_from_root(&project_root, &canonical_cwd);
    let mut instructions = Vec::new();
    let mut remaining_bytes = MAX_INSTRUCTION_BYTES;

    for directory in search_dirs {
        if remaining_bytes == 0 {
            break;
        }

        let Some(path) = instruction_file_for_directory(&directory) else {
            continue;
        };

        let mut data =
            std::fs::read(&path).with_context(|| format!("failed to read {}", path.display()))?;
        let mut truncated = false;
        if data.len() > remaining_bytes {
            data.truncate(remaining_bytes);
            truncated = true;
        }

        let contents = String::from_utf8_lossy(&data).to_string();
        if contents.trim().is_empty() {
            continue;
        }

        remaining_bytes = remaining_bytes.saturating_sub(data.len());

        instructions.push(WorkspaceInstruction {
            path: path.to_string_lossy().to_string(),
            directory: directory.to_string_lossy().to_string(),
            contents,
            truncated,
        });
    }

    Ok(instructions)
}

fn find_project_root(cwd: &Path) -> PathBuf {
    let temp_root = std::env::temp_dir().canonicalize().ok();

    for ancestor in cwd.ancestors() {
        // Shared temp roots like /tmp are process-global and can contain unrelated
        // git metadata. Treat them as a hard boundary so ephemeral workspaces do not
        // accidentally inherit instruction scope from ambient temp directories.
        if temp_root
            .as_deref()
            .is_some_and(|temp_root| ancestor == temp_root)
        {
            break;
        }

        if PROJECT_ROOT_MARKERS
            .iter()
            .any(|marker| ancestor.join(marker).exists())
        {
            return ancestor.to_path_buf();
        }
    }

    cwd.to_path_buf()
}

fn directories_from_root(root: &Path, cwd: &Path) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let mut cursor = cwd.to_path_buf();

    loop {
        directories.push(cursor.clone());
        if cursor == root {
            break;
        }

        let Some(parent) = cursor.parent() else {
            break;
        };
        cursor = parent.to_path_buf();
    }

    directories.reverse();
    directories
}

fn instruction_file_for_directory(directory: &Path) -> Option<PathBuf> {
    WORKSPACE_INSTRUCTION_FILES
        .iter()
        .map(|name| directory.join(name))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::load_workspace_instructions;

    fn temp_path(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{unique}"))
    }

    #[test]
    fn loads_instructions_from_project_root_to_cwd() {
        let root = temp_path("sprocket-instructions");
        let nested = root.join("packages/app");
        fs::create_dir_all(&nested).expect("nested dir should be created");
        fs::create_dir_all(root.join(".git")).expect("git marker should be created");
        fs::write(root.join("AGENTS.md"), "root instructions").expect("root instructions");
        fs::write(nested.join("AGENTS.md"), "nested instructions").expect("nested instructions");

        let instructions = load_workspace_instructions(&nested).expect("instructions should load");

        assert_eq!(instructions.len(), 2);
        assert_eq!(instructions[0].contents, "root instructions");
        assert_eq!(instructions[1].contents, "nested instructions");

        fs::remove_dir_all(root).expect("temp workspace should be removed");
    }

    #[test]
    fn prefers_override_file_when_present() {
        let root = temp_path("sprocket-instructions-override");
        fs::create_dir_all(root.join(".git")).expect("git marker should be created");
        fs::write(root.join("AGENTS.md"), "versioned").expect("agents file");
        fs::write(root.join("AGENTS.override.md"), "override").expect("override file");

        let instructions = load_workspace_instructions(&root).expect("instructions should load");

        assert_eq!(instructions.len(), 1);
        assert!(instructions[0].path.ends_with("AGENTS.override.md"));
        assert_eq!(instructions[0].contents, "override");

        fs::remove_dir_all(root).expect("temp workspace should be removed");
    }

    #[test]
    fn only_reads_cwd_when_no_project_root_marker_exists() {
        let root = temp_path("sprocket-instructions-no-marker");
        let nested = root.join("packages/app");
        fs::create_dir_all(&nested).expect("nested dir should be created");
        fs::write(root.join("AGENTS.md"), "root instructions").expect("root instructions");
        fs::write(nested.join("AGENTS.md"), "nested instructions").expect("nested instructions");

        let instructions = load_workspace_instructions(&nested).expect("instructions should load");

        assert_eq!(instructions.len(), 1);
        assert_eq!(instructions[0].contents, "nested instructions");

        fs::remove_dir_all(root).expect("temp workspace should be removed");
    }
}
