include!(concat!(env!("OUT_DIR"), "/builtin_skills_generated.rs"));

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::Path;

    use sha2::{Digest, Sha256};

    use crate::skill_name::validate_skill_name;
    use crate::skills::parse_skill_markdown;

    use super::BUILTIN_SKILLS;

    #[test]
    fn builtin_skills_parse_and_match_directory_names() {
        for &(table_name, contents) in BUILTIN_SKILLS {
            let parsed = parse_skill_markdown(contents)
                .unwrap_or_else(|error| panic!("built-in '{table_name}' failed to parse: {error}"));
            validate_skill_name(&parsed.name).unwrap_or_else(|error| {
                panic!("built-in '{table_name}' has invalid name: {error}")
            });
            assert_eq!(
                parsed.name, table_name,
                "built-in frontmatter name must match skills/ directory name"
            );
        }
    }

    #[test]
    fn vendored_skills_match_skills_lock() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let vendored_dir = manifest_dir.join(".agents/skills");
        let lock_path = manifest_dir.join("skills-lock.json");

        let entries = std::fs::read_dir(&vendored_dir)
            .expect("vendored skills directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("vendored skill directory entries");
        let mut dir_names: Vec<String> = entries
            .into_iter()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| {
                entry
                    .file_name()
                    .into_string()
                    .expect("vendored skill name is UTF-8")
            })
            .collect();
        dir_names.sort();

        let lock_text =
            std::fs::read_to_string(&lock_path).expect("vendored skills require skills-lock.json");
        let lock: SkillsLock =
            serde_json::from_str(&lock_text).expect("skills-lock.json must be valid JSON");
        assert_eq!(lock.version, 1, "unsupported skills-lock.json version");
        assert_eq!(
            dir_names,
            lock.skills.keys().cloned().collect::<Vec<_>>(),
            "vendored skill directories and skills-lock.json entries diverged"
        );

        for (name, entry) in &lock.skills {
            let contents = std::fs::read(vendored_dir.join(name).join("SKILL.md"))
                .expect("vendored skill SKILL.md");
            // The CLI hashes relative paths followed by bytes; build.rs allows only SKILL.md.
            let mut hasher = Sha256::new();
            hasher.update(b"SKILL.md");
            hasher.update(contents);
            assert_eq!(
                hasher
                    .finalize()
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>(),
                entry.computed_hash,
                "vendored skill '{name}' differs from skills-lock.json; restore it with `bun run skills:update`"
            );
        }
    }

    #[derive(serde::Deserialize)]
    struct SkillsLock {
        version: u32,
        skills: BTreeMap<String, SkillsLockEntry>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SkillsLockEntry {
        computed_hash: String,
    }
}
