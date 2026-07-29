use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::project_root::find_project_root;
use crate::skill_name::validate_skill_name;

const MAX_SKILLS: usize = 64;
const MAX_FRONTMATTER_BYTES: usize = 8 * 1024;
const MAX_DESCRIPTION_CHARS: usize = 1024;
const MAX_SKILL_CONTENT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct WorkspaceSkill {
    pub name: String,
    pub description: String,
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
    pub body: String,
}

/// User skill dirs in precedence order: `~/.sprocket/skills`, then `~/.agents/skills`.
pub fn default_user_skills_dirs() -> Vec<PathBuf> {
    let Some(home) = crate::paths::home_dir() else {
        return Vec::new();
    };

    vec![home.join(".sprocket/skills"), home.join(".agents/skills")]
}

/// Load skills with precedence: project, then `user_skills_dirs`, then `builtin`.
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

    scan_skills_dir(
        &project_root.join(".sprocket/skills"),
        "project",
        &mut by_name,
        &mut warnings,
    );

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

    let mut name: Option<String> = None;
    let mut description: Option<String> = None;

    for line in frontmatter.lines() {
        if line.trim().is_empty() || starts_with_yaml_indent(line) {
            continue;
        }

        let trimmed = line.trim_end();
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();

        match key {
            "name" => {
                let value = strip_yaml_quotes(value);
                if !value.is_empty() {
                    name = Some(value.to_string());
                }
            }
            "description" => {
                if value.starts_with('>') || value.starts_with('|') {
                    return Err("description must be a single-line string".to_string());
                }
                let value = strip_yaml_quotes(value);
                if !value.is_empty() {
                    description = Some(value.to_string());
                }
            }
            _ => {}
        }
    }

    let name = name.ok_or_else(|| "missing or empty name".to_string())?;
    let mut description = description.ok_or_else(|| "missing or empty description".to_string())?;
    if description.chars().count() > MAX_DESCRIPTION_CHARS {
        description = description.chars().take(MAX_DESCRIPTION_CHARS).collect();
    }

    Ok(ParsedSkill {
        name,
        description,
        body: body.to_string(),
    })
}

/// Resolve skill body for `read_skill`, capped at 64 KiB.
pub fn read_skill_content(skill: &WorkspaceSkill) -> Result<ReadSkillContent, String> {
    let (raw, truncated) = match &skill.source {
        SkillSource::File { skill_md_path } => {
            read_file_capped(skill_md_path, MAX_SKILL_CONTENT_BYTES)
                .map_err(|error| format!("failed to read skill '{}': {error}", skill.name))?
        }
        SkillSource::BuiltIn { contents } => {
            let bytes = contents.as_bytes();
            let truncated = bytes.len() > MAX_SKILL_CONTENT_BYTES;
            let raw = if truncated {
                bytes[..MAX_SKILL_CONTENT_BYTES].to_vec()
            } else {
                bytes.to_vec()
            };
            (raw, truncated)
        }
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
        truncated,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadSkillContent {
    pub name: String,
    pub description: String,
    pub content: String,
    pub dir: Option<String>,
    pub truncated: bool,
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
    let (data, _) = read_file_capped(&skill_md_path, MAX_FRONTMATTER_BYTES).map_err(|error| {
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
        source: SkillSource::File { skill_md_path },
    })
}

fn read_file_capped(path: &Path, max_bytes: usize) -> std::io::Result<(Vec<u8>, bool)> {
    use std::io::Read;

    let file = std::fs::File::open(path)?;
    let mut limited = file.take(max_bytes.saturating_add(1) as u64);
    let mut buf = Vec::new();
    limited.read_to_end(&mut buf)?;
    let truncated = buf.len() > max_bytes;
    if truncated {
        buf.truncate(max_bytes);
    }
    Ok((buf, truncated))
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
        if line.trim() == "---" {
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

fn strip_yaml_quotes(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return &value[1..value.len() - 1];
        }
    }
    value
}

fn starts_with_yaml_indent(line: &str) -> bool {
    line.starts_with(' ') || line.starts_with('\t')
}

#[cfg(test)]
mod tests {
    use std::fs;

    use crate::test_support::temp_workspace;

    use super::*;

    fn write_skill(dir: &Path, name: &str, description: &str, body: &str) {
        let skill_dir = dir.join(name);
        fs::create_dir_all(&skill_dir).expect("skill dir");
        fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n{body}\n"),
        )
        .expect("skill file");
    }

    #[test]
    fn discovers_across_sources_with_precedence_and_sorts() {
        let root = temp_workspace();
        let project_skills = root.join(".sprocket/skills");
        let sprocket_user = temp_workspace();
        let agents_user = temp_workspace();
        gix::init(&root).expect("git repository");
        fs::create_dir_all(&project_skills).expect("project skills");

        write_skill(&project_skills, "alpha", "from project", "project body");
        write_skill(&project_skills, "shared", "project wins", "project shared");
        write_skill(&sprocket_user, "shared", "sprocket user", "sprocket shared");
        write_skill(&sprocket_user, "bravo", "from sprocket", "sprocket body");
        write_skill(&agents_user, "shared", "agents user", "agents shared");
        write_skill(&agents_user, "charlie", "from agents", "agents body");

        let builtin = [
            (
                "shared",
                "---\nname: shared\ndescription: built-in\n---\nbuiltin body\n",
            ),
            (
                "delta",
                "---\nname: delta\ndescription: from builtin\n---\nbuiltin delta\n",
            ),
        ];

        let loaded = load_workspace_skills(
            &root,
            &[sprocket_user.clone(), agents_user.clone()],
            &builtin,
        );

        let names: Vec<_> = loaded
            .skills
            .iter()
            .map(|skill| skill.name.as_str())
            .collect();
        assert_eq!(names, vec!["alpha", "bravo", "charlie", "delta", "shared"]);

        let shared = loaded
            .skills
            .iter()
            .find(|skill| skill.name == "shared")
            .expect("shared skill");
        assert_eq!(shared.description, "project wins");
        assert!(matches!(shared.source, SkillSource::File { .. }));

        let delta = loaded
            .skills
            .iter()
            .find(|skill| skill.name == "delta")
            .expect("delta skill");
        assert!(matches!(delta.source, SkillSource::BuiltIn { .. }));

        fs::remove_dir_all(root).ok();
        fs::remove_dir_all(sprocket_user).ok();
        fs::remove_dir_all(agents_user).ok();
    }

    #[test]
    fn skips_invalid_skills_with_warnings() {
        let root = temp_workspace();
        let skills = root.join(".sprocket/skills");
        gix::init(&root).expect("git repository");
        fs::create_dir_all(&skills).expect("skills dir");

        let mismatch = skills.join("good-name");
        fs::create_dir_all(&mismatch).unwrap();
        fs::write(
            mismatch.join("SKILL.md"),
            "---\nname: other-name\ndescription: mismatch\n---\nbody\n",
        )
        .unwrap();

        write_skill(&skills, "BadName", "uppercase", "body");
        write_skill(&skills, "-leading", "leading hyphen", "body");

        let no_desc = skills.join("no-desc");
        fs::create_dir_all(&no_desc).unwrap();
        fs::write(no_desc.join("SKILL.md"), "---\nname: no-desc\n---\nbody\n").unwrap();

        let no_fm = skills.join("no-frontmatter");
        fs::create_dir_all(&no_fm).unwrap();
        fs::write(no_fm.join("SKILL.md"), "# Just markdown\n").unwrap();

        let loaded = load_workspace_skills(&root, &[], &[]);
        assert!(loaded.skills.is_empty());
        assert!(
            loaded
                .warnings
                .iter()
                .any(|warning| warning.contains("does not match directory name"))
        );
        assert!(
            loaded
                .warnings
                .iter()
                .any(|warning| warning.contains("lowercase letters"))
        );
        assert!(
            loaded
                .warnings
                .iter()
                .any(|warning| warning.contains("must not start or end with '-'"))
        );
        assert!(
            loaded
                .warnings
                .iter()
                .any(|warning| warning.contains("missing or empty description"))
        );
        assert!(
            loaded
                .warnings
                .iter()
                .any(|warning| warning.contains("missing YAML frontmatter"))
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn frontmatter_parser_handles_quotes_unknown_keys_and_nested_blocks() {
        let contents = "---\nname: \"pdf-processing\"\ndescription: 'Handle PDFs'\nlicense: MIT\nmetadata:\n  author: sprocket\n  version: \"1\"\ncompatibility: \"claude\"\n---\n# Body\n\nDo the thing.\n";
        let parsed = parse_skill_markdown(contents).expect("should parse");
        assert_eq!(parsed.name, "pdf-processing");
        assert_eq!(parsed.description, "Handle PDFs");
        assert_eq!(parsed.body, "# Body\n\nDo the thing.\n");
    }

    #[test]
    fn rejects_block_scalar_descriptions() {
        let folded = "---\nname: folded\ndescription: >-\n  A long description\n---\nbody\n";
        let error = parse_skill_markdown(folded).expect_err("folded description");
        assert!(error.contains("single-line"));

        let literal = "---\nname: literal\ndescription: |\n  line one\n---\nbody\n";
        let error = parse_skill_markdown(literal).expect_err("literal description");
        assert!(error.contains("single-line"));
    }

    #[test]
    fn discovery_and_content_reads_stay_byte_capped() {
        let root = temp_workspace();
        let skills = root.join(".sprocket/skills");
        let skill_dir = skills.join("huge");
        gix::init(&root).expect("git repository");
        fs::create_dir_all(&skill_dir).unwrap();

        let mut contents = String::from("---\nname: huge\ndescription: oversized\n---\n");
        contents.push_str(&"x".repeat(MAX_SKILL_CONTENT_BYTES + 8 * 1024));
        fs::write(skill_dir.join("SKILL.md"), &contents).unwrap();

        let loaded = load_workspace_skills(&root, &[], &[]);
        assert_eq!(loaded.skills.len(), 1);
        assert_eq!(loaded.skills[0].name, "huge");

        let content = read_skill_content(&loaded.skills[0]).expect("read");
        assert!(content.truncated);
        assert!(content.content.len() <= MAX_SKILL_CONTENT_BYTES);

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn read_skill_content_strips_frontmatter_and_returns_dir() {
        let root = temp_workspace();
        let skills = root.join(".sprocket/skills");
        gix::init(&root).expect("git repository");
        write_skill(&skills, "demo", "A demo skill", "# Instructions\n\nGo.");

        let loaded = load_workspace_skills(&root, &[], &[]);
        let skill = loaded.skills.iter().find(|s| s.name == "demo").unwrap();
        let content = read_skill_content(skill).expect("read");
        assert_eq!(content.name, "demo");
        assert_eq!(content.description, "A demo skill");
        assert_eq!(content.content, "# Instructions\n\nGo.\n");
        assert!(!content.truncated);
        assert_eq!(
            content.dir.as_deref(),
            Some(skills.join("demo").to_string_lossy().as_ref())
        );

        fs::remove_dir_all(root).ok();
    }
}
