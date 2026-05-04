use std::path::PathBuf;

use crate::text::limit_chars;
use crate::workspace::{relative_to_root, resolve_read_path, resolve_workspace_path};
use anyhow::{Context, Result, bail};
use serde::Serialize;

const DEFAULT_FILE_READ_LINES: usize = 220;
const MAX_FILE_READ_LINES: usize = 400;
const MAX_FILE_READ_CHARS: usize = 20_000;

#[derive(Clone)]
pub(crate) struct WorkspaceTools {
    root: PathBuf,
}

impl WorkspaceTools {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn root(&self) -> &PathBuf {
        &self.root
    }

    async fn read_file(
        &self,
        relative_path: &str,
        start_line: Option<usize>,
        max_lines: Option<usize>,
    ) -> Result<FileReadOutput> {
        let path = match resolve_read_path(self.root(), relative_path) {
            Ok(path) => path,
            Err(error) => {
                return Ok(file_read_error_output(
                    self.root(),
                    &PathBuf::from(relative_path),
                    false,
                    error.to_string(),
                ));
            }
        };
        let display_path = relative_to_root(self.root(), &path);
        let exists = match tokio::fs::try_exists(&path).await {
            Ok(exists) => exists,
            Err(error) => {
                return Ok(file_read_error_output(
                    self.root(),
                    &path,
                    path.exists(),
                    format!("failed to inspect {}: {error}", path.display()),
                ));
            }
        };
        if !exists {
            return Ok(file_read_error_output(
                self.root(),
                &path,
                false,
                format!("path does not exist: {}", path.display()),
            ));
        }

        let contents = match tokio::fs::read_to_string(&path).await {
            Ok(contents) => contents,
            Err(error) => {
                return Ok(file_read_error_output(
                    self.root(),
                    &path,
                    true,
                    format!("failed to read {}: {error}", path.display()),
                ));
            }
        };
        let start_line = start_line.unwrap_or(1).max(1);
        let max_lines = max_lines
            .unwrap_or(DEFAULT_FILE_READ_LINES)
            .clamp(1, MAX_FILE_READ_LINES);
        let (contents, start_line, end_line, total_lines, truncated) =
            match slice_file_contents(&contents, start_line, max_lines) {
                Ok(slice) => slice,
                Err(error) => {
                    return Ok(file_read_error_output(
                        self.root(),
                        &path,
                        true,
                        error.to_string(),
                    ));
                }
            };
        let (contents, char_truncated) = limit_chars(&contents, MAX_FILE_READ_CHARS);

        Ok(FileReadOutput {
            path: display_path,
            exists: true,
            start_line,
            end_line,
            total_lines,
            truncated: truncated || char_truncated,
            contents,
            error: None,
        })
    }

    async fn create_file(&self, relative_path: &str, content: &str) -> Result<FileWriteOutput> {
        let path = resolve_workspace_path(self.root(), relative_path, true)?;
        if tokio::fs::try_exists(&path)
            .await
            .with_context(|| format!("failed to inspect {}", path.display()))?
        {
            bail!("file already exists: {}", path.display());
        }

        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }

        tokio::fs::write(&path, content.as_bytes())
            .await
            .with_context(|| format!("failed to write {}", path.display()))?;

        Ok(FileWriteOutput {
            path: relative_to_root(self.root(), &path),
            bytes_written: content.len(),
        })
    }

    async fn replace_in_file(
        &self,
        relative_path: &str,
        old_text: &str,
        new_text: &str,
        replace_all: bool,
    ) -> Result<FileEditOutput> {
        if old_text.is_empty() {
            bail!("old_text cannot be empty");
        }

        let path = resolve_workspace_path(self.root(), relative_path, false)?;
        let contents = tokio::fs::read_to_string(&path)
            .await
            .with_context(|| format!("failed to read {}", path.display()))?;
        let occurrences = contents.matches(old_text).count();

        if occurrences == 0 {
            bail!("target text was not found in {}", path.display());
        }

        if occurrences > 1 && !replace_all {
            bail!(
                "target text matched {} times in {}; retry with replace_all=true or use a more specific old_text",
                occurrences,
                path.display()
            );
        }

        let next_contents = if replace_all {
            contents.replace(old_text, new_text)
        } else {
            contents.replacen(old_text, new_text, 1)
        };

        tokio::fs::write(&path, next_contents.as_bytes())
            .await
            .with_context(|| format!("failed to write {}", path.display()))?;

        Ok(FileEditOutput {
            path: relative_to_root(self.root(), &path),
            replacements: if replace_all { occurrences } else { 1 },
            bytes_written: next_contents.len(),
        })
    }
}

fn file_read_error_output(
    root: &PathBuf,
    path: &std::path::Path,
    exists: bool,
    error: String,
) -> FileReadOutput {
    FileReadOutput {
        path: relative_to_root(root, path),
        exists,
        start_line: 1,
        end_line: 0,
        total_lines: 0,
        truncated: false,
        contents: String::new(),
        error: Some(error),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadOutput {
    pub path: String,
    pub exists: bool,
    pub start_line: usize,
    pub end_line: usize,
    pub total_lines: usize,
    pub truncated: bool,
    pub contents: String,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteOutput {
    pub path: String,
    pub bytes_written: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEditOutput {
    pub path: String,
    pub replacements: usize,
    pub bytes_written: usize,
}

fn slice_file_contents(
    contents: &str,
    start_line: usize,
    max_lines: usize,
) -> Result<(String, usize, usize, usize, bool)> {
    let lines = split_lines(contents);
    let total_lines = lines.len();

    if total_lines == 0 {
        return Ok((String::new(), 1, 0, 0, false));
    }

    if start_line > total_lines {
        bail!(
            "start_line {} is past the end of the file ({} lines)",
            start_line,
            total_lines
        );
    }

    let start_index = start_line - 1;
    let end_index = (start_index + max_lines).min(total_lines);
    let slice = lines[start_index..end_index].concat();

    Ok((
        slice,
        start_line,
        end_index,
        total_lines,
        end_index < total_lines,
    ))
}

fn split_lines(contents: &str) -> Vec<&str> {
    contents.split_inclusive('\n').collect()
}

pub async fn read_workspace_file(
    workspace_root: PathBuf,
    path: &str,
    start_line: Option<usize>,
    max_lines: Option<usize>,
) -> Result<FileReadOutput> {
    WorkspaceTools::new(workspace_root)
        .read_file(path, start_line, max_lines)
        .await
}

pub async fn create_workspace_file(
    workspace_root: PathBuf,
    path: &str,
    content: &str,
) -> Result<FileWriteOutput> {
    WorkspaceTools::new(workspace_root)
        .create_file(path, content)
        .await
}

pub async fn replace_workspace_file(
    workspace_root: PathBuf,
    path: &str,
    old_text: &str,
    new_text: &str,
    replace_all: bool,
) -> Result<FileEditOutput> {
    WorkspaceTools::new(workspace_root)
        .replace_in_file(path, old_text, new_text, replace_all)
        .await
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::WorkspaceTools;

    fn temp_workspace() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("sprocket-core-tests-{unique}"));
        fs::create_dir_all(&path).expect("temp dir should be created");
        path
    }

    #[tokio::test]
    async fn replace_in_file_requires_unique_match_without_replace_all() {
        let root = temp_workspace();
        let path = root.join("src.txt");
        fs::write(&path, "alpha\nalpha\n").expect("fixture should be written");

        let tools = WorkspaceTools::new(root.clone());
        let result = tools
            .replace_in_file("src.txt", "alpha", "beta", false)
            .await;

        assert!(result.is_err());

        fs::remove_dir_all(root).expect("temp dir should be removed");
    }

    #[tokio::test]
    async fn read_file_returns_missing_result_instead_of_error() {
        let root = temp_workspace();
        let tools = WorkspaceTools::new(root.clone());

        let output = tools
            .read_file("missing.txt", None, None)
            .await
            .expect("missing file should not fail");

        assert!(!output.exists);
        assert_eq!(output.path, "missing.txt");
        assert_eq!(output.contents, "");
        assert!(
            output
                .error
                .as_deref()
                .is_some_and(|error| error.contains("path does not exist")),
            "unexpected output: {output:?}"
        );

        fs::remove_dir_all(root).expect("temp dir should be removed");
    }

    #[tokio::test]
    async fn read_file_allows_absolute_paths_outside_workspace() {
        let root = temp_workspace();
        let outside = temp_workspace().join("external.txt");
        fs::write(&outside, "outside\n").expect("fixture should be written");
        let tools = WorkspaceTools::new(root.clone());

        let output = tools
            .read_file(&outside.to_string_lossy(), None, None)
            .await
            .expect("outside read should succeed");

        assert!(output.exists);
        assert_eq!(output.path, outside.to_string_lossy());
        assert_eq!(output.contents, "outside\n");

        fs::remove_dir_all(root).expect("temp dir should be removed");
        fs::remove_dir_all(
            outside
                .parent()
                .expect("outside file should have parent")
                .to_path_buf(),
        )
        .expect("temp dir should be removed");
    }

    #[tokio::test]
    async fn read_file_returns_error_output_for_invalid_line_range() {
        let root = temp_workspace();
        let path = root.join("src.txt");
        fs::write(&path, "alpha\n").expect("fixture should be written");
        let tools = WorkspaceTools::new(root.clone());

        let output = tools
            .read_file("src.txt", Some(99), None)
            .await
            .expect("invalid line range should not fail");

        assert!(output.exists);
        assert_eq!(output.contents, "");
        assert!(
            output
                .error
                .as_deref()
                .is_some_and(|error| error.contains("past the end of the file")),
            "unexpected output: {output:?}"
        );

        fs::remove_dir_all(root).expect("temp dir should be removed");
    }
}
