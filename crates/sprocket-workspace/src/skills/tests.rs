use std::fs;

use crate::test_support::temp_workspace;

use super::*;

fn write_skill(dir: &Path, name: &str, description: &str, body: &str) {
    write_skill_with_frontmatter(dir, name, description, body, "");
}

fn write_skill_with_frontmatter(
    dir: &Path,
    name: &str,
    description: &str,
    body: &str,
    frontmatter: &str,
) {
    let skill_dir = dir.join(name);
    fs::create_dir_all(&skill_dir).expect("skill dir");
    fs::write(
        skill_dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {description}\n{frontmatter}---\n{body}\n"),
    )
    .expect("skill file");
}

#[test]
fn discovers_across_sources_with_precedence_and_sorts() {
    let root = temp_workspace();
    let project_skills = root.join(".sprocket/skills");
    let project_agents_skills = root.join(".agents/skills");
    let sprocket_user = temp_workspace();
    let agents_user = temp_workspace();
    gix::init(&root).expect("git repository");
    fs::create_dir_all(&project_skills).expect("project skills");

    write_skill(&project_skills, "alpha", "from project", "project body");
    write_skill_with_frontmatter(
        &project_skills,
        "shared",
        "project wins",
        "project shared",
        "disable-model-invocation: true\n",
    );
    write_skill(
        &project_agents_skills,
        "echo",
        "from project agents",
        "echo body",
    );
    write_skill(
        &project_agents_skills,
        "shared",
        "project agents",
        "agents shared",
    );
    write_skill(&sprocket_user, "shared", "sprocket user", "sprocket shared");
    write_skill_with_frontmatter(
        &sprocket_user,
        "bravo",
        "from sprocket",
        "sprocket body",
        "disable-model-invocation: true\n",
    );
    write_skill(&agents_user, "shared", "agents user", "agents shared");
    write_skill(&agents_user, "charlie", "from agents", "agents body");

    let builtin = [
        (
            "shared",
            "---\nname: shared\ndescription: built-in\n---\nbuiltin body\n",
        ),
        (
            "delta",
            "---\nname: delta\ndescription: from builtin\ndisable-model-invocation: true\n---\nbuiltin delta\n",
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
    assert_eq!(
        names,
        vec!["alpha", "bravo", "charlie", "delta", "echo", "shared"]
    );
    let hidden_names: Vec<_> = loaded
        .skills
        .iter()
        .filter(|skill| skill.disable_model_invocation)
        .map(|skill| skill.name.as_str())
        .collect();
    assert_eq!(hidden_names, vec!["bravo", "delta", "shared"]);

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
    write_skill_with_frontmatter(
        &skills,
        "bad-policy",
        "invalid invocation policy",
        "body",
        "disable-model-invocation: maybe\n",
    );

    let no_desc = skills.join("no-desc");
    fs::create_dir_all(&no_desc).unwrap();
    fs::write(no_desc.join("SKILL.md"), "---\nname: no-desc\n---\nbody\n").unwrap();

    let no_fm = skills.join("no-frontmatter");
    fs::create_dir_all(&no_fm).unwrap();
    fs::write(no_fm.join("SKILL.md"), "# Just markdown\n").unwrap();

    let loaded = load_workspace_skills(&root, &[], &[]);
    assert!(loaded.skills.is_empty());
    assert!(loaded.warnings.iter().any(|warning| {
        warning.contains("bad-policy") && warning.contains("disable-model-invocation: invalid type")
    }));
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
fn parses_optional_disable_model_invocation() {
    for (frontmatter, expected) in [
        ("", false),
        ("disable-model-invocation: false\n", false),
        ("disable-model-invocation: true\n", true),
        ("\"disable-model-invocation\": true\n", true),
        ("disable-model-invocation: TRUE # explicit only\n", true),
        ("metadata:\n  disable-model-invocation: true\n", false),
    ] {
        let contents =
            format!("---\nname: demo\ndescription: demo skill\n{frontmatter}---\nbody\n");
        let parsed = parse_skill_markdown(&contents).expect("valid frontmatter");
        assert_eq!(parsed.disable_model_invocation, expected, "{frontmatter}");
    }
}

#[test]
fn rejects_invalid_disable_model_invocation() {
    for value in ["maybe", "\"true\"", "false\ndisable-model-invocation: true"] {
        let contents = format!(
            "---\nname: demo\ndescription: demo skill\ndisable-model-invocation: {value}\n---\nbody\n"
        );
        let error = parse_skill_markdown(&contents).expect_err("invalid frontmatter");
        assert!(error.contains("disable-model-invocation"), "{error}");
    }
}

#[test]
fn parses_and_normalizes_description_scalars() {
    for scalar in [
        "Handle PDFs when needed",
        "|\n  Handle PDFs\n\n  when needed",
        ">\n  Handle PDFs\n  when needed",
        "Handle PDFs\n  when needed",
        "\"Handle PDFs\nwhen needed\"",
        "\"  Handle\\tPDFs\\nwhen   needed  \"",
    ] {
        let contents = format!(
            "---\nname: demo\ndescription: {scalar}\ndisable-model-invocation: true\nmetadata:\n  description: ignored\n---\n# Body\n"
        );
        let parsed = parse_skill_markdown(&contents).expect(scalar);
        assert_eq!(parsed.description, "Handle PDFs when needed", "{scalar}");
        assert_eq!(parsed.name, "demo");
        assert!(parsed.disable_model_invocation);
        assert_eq!(parsed.body, "# Body\n");
    }
}

#[test]
fn preserves_indented_frontmatter_delimiters_in_descriptions() {
    for closing in ["---", "--- \t"] {
        let contents =
            format!("---\nname: demo\ndescription: |\n  First\n  ---\n  Last\n{closing}\n# Body\n");
        let parsed = parse_skill_markdown(&contents).expect("literal description");
        assert_eq!(parsed.description, "First --- Last");
        assert_eq!(parsed.body, "# Body\n");
    }
}

#[test]
fn rejects_missing_or_empty_descriptions() {
    for frontmatter in ["", "description:", "description: \"  \\t\\n  \""] {
        let contents = format!("---\nname: demo\n{frontmatter}\n---\nbody\n");
        let error = parse_skill_markdown(&contents).expect_err(frontmatter);
        assert_eq!(error, "missing or empty description", "{frontmatter}");
    }
}

#[tokio::test]
async fn discovers_large_frontmatter_and_returns_complete_file_content() {
    let root = temp_workspace();
    let skills = root.join(".sprocket/skills");
    let skill_dir = skills.join("huge");
    gix::init(&root).expect("git repository");
    fs::create_dir_all(&skill_dir).unwrap();

    let body = format!("{}\nFinal instruction.\n", "λ".repeat(40 * 1024));
    let description = "λ".repeat(6000);
    let metadata = "x".repeat(10 * 1024);
    let contents =
        format!("---\nname: huge\ndescription: {description}\nmetadata: {metadata}\n---\n{body}");
    fs::write(skill_dir.join("SKILL.md"), &contents).unwrap();

    let loaded = load_workspace_skills(&root, &[], &[]);
    assert_eq!(loaded.skills.len(), 1);
    assert_eq!(loaded.skills[0].name, "huge");
    assert_eq!(loaded.skills[0].description, description);

    let content = read_skill_content(&loaded.skills[0], &root, &[], &Default::default())
        .await
        .expect("read");
    assert_eq!(content.description, description);
    assert_eq!(content.content, body);

    fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn read_skill_content_strips_frontmatter_and_runs_placeholders() {
    let root = temp_workspace();
    let skills = root.join(".sprocket/skills");
    gix::init(&root).expect("git repository");
    write_skill(
        &skills,
        "demo",
        "A demo skill",
        "# Instructions\n\nGreeting: !`echo hello`\n\nGo.",
    );

    let loaded = load_workspace_skills(&root, &[], &[]);
    let skill = loaded.skills.iter().find(|s| s.name == "demo").unwrap();
    let content = read_skill_content(skill, &root, &[], &Default::default())
        .await
        .expect("read");
    assert_eq!(content.name, "demo");
    assert_eq!(content.description, "A demo skill");
    assert_eq!(
        content.content,
        "# Instructions\n\nGreeting: hello\n\nGo.\n"
    );
    assert_eq!(
        content.dir.as_deref(),
        Some(skills.join("demo").to_string_lossy().as_ref())
    );

    fs::remove_dir_all(root).ok();
}
