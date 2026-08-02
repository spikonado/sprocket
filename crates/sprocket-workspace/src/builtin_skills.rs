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
}
