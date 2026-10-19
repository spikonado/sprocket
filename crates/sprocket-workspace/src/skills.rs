use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::project_root::find_project_root;
use crate::skill_name::validate_skill_name;

const MAX_SKILLS: usize = 64;

#[derive(Debug, Clone)]
pub struct WorkspaceSkill {
    pub name: String,
    pub description: String,
    pub disable_model_invocation: bool,
    pub source: SkillSource,
}

#[derive(Debug, Clone)]
pub enum SkillSource {
    File { skill_md_path: PathBuf },
    BuiltIn { contents: &'static str },
}

#[derive(Debug, Default)]
pub struct WorkspaceSkills {
    pub skills: Vec<WorkspaceSkill>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedSkill {
    pub name: String,
    pub description: String,
    pub disable_model_invocation: bool,
    pub body: String,
}

#[derive(Deserialize)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
    #[serde(rename = "disable-model-invocation")]
    disable_model_invocation: Option<bool>,
}

/// User skill dirs in precedence order: `~/.sprocket/skills`, then `~/.agents/skills`.
pub fn default_user_skills_dirs() -> Vec<PathBuf> {
    let Some(home) = crate::paths::home_dir() else {
        return Vec::new();
    };

    vec![home.join(".sprocket/skills"), home.join(".agents/skills")]
}

/// Load skills with precedence: project `.sprocket/skills`, project `.agents/skills`, then `user_skills_dirs`, then `builtin`.
pub fn load_workspace_skills(
    cwd: &Path,
    user_skills_dirs: &[PathBuf],
    builtin: &[(&str, &'static str)],
) -> WorkspaceSkills {
    let mut warnings = Vec::new();
    let canonical_cwd = match cwd.canonicalize() {
        Ok(path) => path,
        Err(error) => {
            warnings.push(format!(
                "failed to resolve workspace {}: {error}",
                cwd.display()
            ));
            return WorkspaceSkills {
                skills: Vec::new(),
                warnings,
            };
        }
    };

    let project_root = find_project_root(&canonical_cwd);
    let mut by_name: HashMap<String, WorkspaceSkill> = HashMap::new();

    for project_dir in [".sprocket/skills", ".agents/skills"] {
        scan_skills_dir(
            &project_root.join(project_dir),
            "project",
            &mut by_name,
            &mut warnings,
        );
    }

    for user_dir in user_skills_dirs {
        let label = user_dir.display().to_string();
        scan_skills_dir(user_dir, &label, &mut by_name, &mut warnings);
    }

    for &(table_name, contents) in builtin {
        if by_name.len() >= MAX_SKILLS && !by_name.contains_key(table_name) {
            warnings.push(format!(
                "skipped built-in skill '{table_name}': skill registry is full ({MAX_SKILLS})"
            ));
            continue;
        }
        if by_name.contains_key(table_name) {
            continue;
        }

        match parse_and_validate_builtin(table_name, contents) {
            Ok(skill) => {
                by_name.insert(skill.name.clone(), skill);
            }
            Err(warning) => warnings.push(warning),
        }
    }

    let mut skills: Vec<WorkspaceSkill> = by_name.into_values().collect();
    skills.sort_by(|left, right| left.name.cmp(&right.name));

    WorkspaceSkills { skills, warnings }
}

/// Parse SKILL.md frontmatter (`name`, `description`) and return the body.
pub(crate) fn parse_skill_markdown(contents: &str) -> Result<ParsedSkill, String> {
    let Some((frontmatter, body)) = split_frontmatter(contents) else {
        return Err("missing YAML frontmatter".to_string());
    };
    let frontmatter: Frontmatter = serde_yaml_ng::from_str(frontmatter)
        .map_err(|error| format!("invalid YAML frontmatter: {error}"))?;

    let name = frontmatter
        .name
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "missing or empty name".to_string())?;
    let description = frontmatter
        .description
        .map(|description| description.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|description| !description.is_empty())
        .ok_or_else(|| "missing or empty description".to_string())?;

    Ok(ParsedSkill {
        name,
        description,
        disable_model_invocation: frontmatter.disable_model_invocation.unwrap_or(false),
        body: body.to_string(),
    })
}

pub fn read_skill_content(skill: &WorkspaceSkill) -> Result<ReadSkillContent, String> {
    let raw = match &skill.source {
        SkillSource::File { skill_md_path } => Cow::Owned(
            std::fs::read(skill_md_path)
                .map_err(|error| format!("failed to read skill '{}': {error}", skill.name))?,
        ),
        SkillSource::BuiltIn { contents } => Cow::Borrowed(contents.as_bytes()),
    };

    let text = String::from_utf8_lossy(&raw);
    let Some((_, body)) = split_frontmatter(&text) else {
        return Err("missing YAML frontmatter".to_string());
    };

    let dir = match &skill.source {
        SkillSource::File { skill_md_path } => skill_md_path
            .parent()
            .map(|parent| parent.to_string_lossy().to_string()),
        SkillSource::BuiltIn { .. } => None,
    };

    Ok(ReadSkillContent {
        name: skill.name.clone(),
        description: skill.description.clone(),
        content: body.to_string(),
        dir,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadSkillContent {
    pub name: String,
    pub description: String,
    pub content: String,
    pub dir: Option<String>,
}

fn parse_and_validate_builtin(
    table_name: &str,
    contents: &'static str,
) -> Result<WorkspaceSkill, String> {
    let parsed = parse_skill_markdown(contents)
        .map_err(|error| format!("skipped built-in skill '{table_name}': {error}"))?;
    validate_skill_name(&parsed.name)
        .map_err(|error| format!("skipped built-in skill '{table_name}': {error}"))?;
    if parsed.name != table_name {
        return Err(format!(
            "skipped built-in skill '{table_name}': frontmatter name '{}' does not match table key",
            parsed.name
        ));
    }

    Ok(WorkspaceSkill {
        name: parsed.name,
        description: parsed.description,
        disable_model_invocation: parsed.disable_model_invocation,
        source: SkillSource::BuiltIn { contents },
    })
}

fn scan_skills_dir(
    dir: &Path,
    source_label: &str,
    by_name: &mut HashMap<String, WorkspaceSkill>,
    warnings: &mut Vec<String>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            warnings.push(format!(
                "failed to read skills directory {} ({source_label}): {error}",
                dir.display()
            ));
            return;
        }
    };

    let mut dirs: Vec<PathBuf> = entries
        .filter_map(|entry| match entry {
            Ok(entry) => Some(entry.path()),
            Err(error) => {
                warnings.push(format!(
                    "failed to read entry in skills directory {} ({source_label}): {error}",
                    dir.display()
                ));
                None
            }
        })
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();

    for skill_dir in dirs {
        if by_name.len() >= MAX_SKILLS {
            warnings.push(format!(
                "skipped remaining skills in {} ({source_label}): skill registry is full ({MAX_SKILLS})",
                dir.display()
            ));
            break;
        }

        let dir_name = match skill_dir.file_name().and_then(|name| name.to_str()) {
            Some(name) => name.to_string(),
            None => {
                warnings.push(format!(
                    "skipped skill at {}: directory name is not valid UTF-8",
                    skill_dir.display()
                ));
                continue;
            }
        };

        if by_name.contains_key(&dir_name) {
            continue;
        }

        match load_file_skill(&skill_dir, &dir_name) {
            Ok(skill) => {
                by_name.insert(skill.name.clone(), skill);
            }
            Err(warning) => warnings.push(warning),
        }
    }
}

fn load_file_skill(skill_dir: &Path, dir_name: &str) -> Result<WorkspaceSkill, String> {
    let skill_md_path = skill_dir.join("SKILL.md");
    let data = std::fs::read(&skill_md_path).map_err(|error| {
        format!(
            "skipped skill '{dir_name}': failed to read {}: {error}",
            skill_md_path.display()
        )
    })?;

    let text = String::from_utf8_lossy(&data);
    let parsed = parse_skill_markdown(&text).map_err(|error| {
        format!(
            "skipped skill '{dir_name}' at {}: {error}",
            skill_md_path.display()
        )
    })?;
    validate_skill_name(&parsed.name).map_err(|error| {
        format!(
            "skipped skill '{dir_name}' at {}: {error}",
            skill_md_path.display()
        )
    })?;

    if parsed.name != dir_name {
        return Err(format!(
            "skipped skill '{dir_name}' at {}: frontmatter name '{}' does not match directory name",
            skill_md_path.display(),
            parsed.name
        ));
    }

    Ok(WorkspaceSkill {
        name: parsed.name,
        description: parsed.description,
        disable_model_invocation: parsed.disable_model_invocation,
        source: SkillSource::File { skill_md_path },
    })
}

fn split_frontmatter(contents: &str) -> Option<(&str, &str)> {
    let contents = contents.strip_prefix('\u{feff}').unwrap_or(contents);
    if !contents.starts_with("---") {
        return None;
    }
    let after_open = match contents.as_bytes().get(3) {
        Some(b'\n') => 4,
        Some(b'\r') if contents.as_bytes().get(4) == Some(&b'\n') => 5,
        _ => return None,
    };

    let mut index = after_open;
    while index < contents.len() {
        let next_newline = contents[index..]
            .find('\n')
            .map(|offset| index + offset)
            .unwrap_or(contents.len());
        let line = contents[index..next_newline].trim_end_matches('\r');
        if line.trim_end() == "---" {
            let frontmatter = &contents[after_open..index];
            let mut body_start = next_newline;
            if body_start < contents.len() && contents.as_bytes()[body_start] == b'\n' {
                body_start += 1;
            }
            return Some((frontmatter, &contents[body_start..]));
        }
        if next_newline >= contents.len() {
            break;
        }
        index = next_newline + 1;
    }
    None
}

#[cfg(test)]
mod tests;
