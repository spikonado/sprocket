include!(concat!(env!("OUT_DIR"), "/builtin_skills_generated.rs"));

#[cfg(test)]
mod tests {
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
}
