use serde::Deserialize;

pub(crate) const WORKSPACE_CONTEXT_HEADER: &str = "# Thread-Scoped Workspace Context\n\nThe following workspace context was loaded when this conversation began.\n\n";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceContextSnapshot {
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
    pub(crate) before_part_number: u32,
    pub(crate) text: String,
}

impl WorkspaceContextSnapshot {
    pub(crate) fn update_text(&self) -> String {
        format!(
            "# Updated Workspace Context\n\nThe following available skills and AGENTS.md instructions supersede the previous workspace context, including any skills or instructions that have been removed.\n\n{}",
            self.text
                .strip_prefix(WORKSPACE_CONTEXT_HEADER)
                .unwrap_or(&self.text)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_supersedes_removed_skills_and_instructions() {
        let snapshot = WorkspaceContextSnapshot {
            before_part_number: 3,
            text: format!(
                "{WORKSPACE_CONTEXT_HEADER}## Available Skills\n\nNo skills are installed.\n\n## Preloaded AGENTS.md Instructions\n\nNo AGENTS.md instructions were preloaded for the current workspace."
            ),
        };
        let update = snapshot.update_text();
        assert!(update.starts_with("# Updated Workspace Context\n"));
        assert!(update.contains("including any skills or instructions that have been removed"));
        assert!(update.contains("No skills are installed."));
        assert!(update.contains("No AGENTS.md instructions were preloaded"));
        assert!(!update.contains("loaded when this conversation began"));
    }
}
