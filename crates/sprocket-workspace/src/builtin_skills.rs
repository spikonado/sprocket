include!(concat!(env!("OUT_DIR"), "/builtin_skills_generated.rs"));

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    use sha2::{Digest, Sha256};

    use crate::skill_name::validate_skill_name;
    use crate::skills::parse_skill_markdown;

    use super::BUILTIN_SKILLS;

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
    fn artifacts_skill_teaches_create_artifact_tool() {
        let (_, contents) = BUILTIN_SKILLS
            .iter()
            .copied()
            .find(|(name, _)| *name == "artifacts")
            .expect("artifacts built-in skill must exist");
        let parsed = parse_skill_markdown(contents).expect("artifacts skill parses");
        assert!(
            parsed.description.to_lowercase().contains("react")
                || parsed.description.to_lowercase().contains("design"),
            "description should mention react/design so the agent selects it"
        );
        assert!(
            parsed.body.contains("create_artifact"),
            "skill body must instruct use of create_artifact"
        );
        assert!(
            parsed.body.contains("contentType"),
            "skill body must document contentType including react"
        );
        assert!(
            parsed.body.contains("App"),
            "skill body must require an App component for react previews"
        );
    }

    #[test]
    fn ucp_shopping_skill_teaches_checkout_flow() {
        let (_, contents) = BUILTIN_SKILLS
            .iter()
            .copied()
            .find(|(name, _)| *name == "ucp-shopping")
            .expect("ucp-shopping built-in skill must exist");
        let parsed = parse_skill_markdown(contents).expect("ucp-shopping skill parses");
        assert!(
            parsed.description.to_lowercase().contains("shop")
                || parsed.description.to_lowercase().contains("buy"),
            "description should mention shopping/buying so the agent selects it"
        );
        assert!(
            parsed.body.contains("/.well-known/ucp"),
            "skill body must teach profile discovery"
        );
        assert!(
            parsed.body.contains("checkout-sessions"),
            "skill body must teach the checkout session endpoints"
        );
        assert!(
            parsed.body.contains("continue_url"),
            "skill body must teach browser tool handoff via continue_url"
        );
        assert!(
            parsed.body.contains("mandate_charge"),
            "skill body must teach paying with a Prava mandate credential"
        );
    }

    #[test]
    fn vendored_skills_match_skills_lock() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let vendored_dir = manifest_dir.join(".agents/skills");
        let lock_path = manifest_dir.join("skills-lock.json");

        let mut dir_names: Vec<String> = std::fs::read_dir(&vendored_dir)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| entry.path().is_dir())
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default();
        dir_names.sort();

        if dir_names.is_empty() {
            assert!(
                !lock_path.exists(),
                "skills-lock.json exists but no vendored skills are present"
            );
            return;
        }

        let lock_text =
            std::fs::read_to_string(&lock_path).expect("vendored skills require skills-lock.json");
        let lock: SkillsLock =
            serde_json::from_str(&lock_text).expect("skills-lock.json must be valid JSON");
        assert_eq!(
            lock.version, 1,
            "unsupported skills-lock.json version; re-check the skills CLI lock format and hash algorithm"
        );

        let lock_names: Vec<&String> = lock.skills.keys().collect();
        assert_eq!(
            dir_names,
            lock_names
                .iter()
                .map(|name| name.as_str())
                .collect::<Vec<_>>(),
            "vendored skill directories and skills-lock.json entries diverged"
        );

        for (name, entry) in &lock.skills {
            let actual = compute_skill_folder_hash(&vendored_dir.join(name))
                .expect("hash vendored skill directory");
            assert_eq!(
                actual, entry.computed_hash,
                "vendored skill '{name}' differs from skills-lock.json; restore it with `bun run skills:update` — vendored skills must stay byte-identical to upstream"
            );
        }
    }

    // Mirrors computeSkillFolderHash in vercel-labs/skills (src/local-lock.ts):
    // SHA-256 over each file's slash-separated relative path followed by its
    // bytes, files sorted by relative path.
    fn compute_skill_folder_hash(skill_dir: &Path) -> std::io::Result<String> {
        let mut files: Vec<(String, Vec<u8>)> = Vec::new();
        collect_hash_files(skill_dir, skill_dir, &mut files)?;
        files.sort_by(|left, right| left.0.cmp(&right.0));

        let mut hasher = Sha256::new();
        for (relative_path, contents) in files {
            hasher.update(relative_path.as_bytes());
            hasher.update(contents);
        }
        Ok(format!("{:x}", hasher.finalize()))
    }

    fn collect_hash_files(
        base: &Path,
        dir: &Path,
        files: &mut Vec<(String, Vec<u8>)>,
    ) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path: PathBuf = entry.path();
            if path.is_dir() {
                let name = entry.file_name();
                if name == ".git" || name == "node_modules" {
                    continue;
                }
                collect_hash_files(base, &path, files)?;
            } else if path.is_file() {
                let relative = path
                    .strip_prefix(base)
                    .expect("entry lives under the skill directory")
                    .to_string_lossy()
                    .replace('\\', "/");
                files.push((relative, std::fs::read(&path)?));
            }
        }
        Ok(())
    }
}
