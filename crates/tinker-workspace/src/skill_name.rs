//! Shared skill-name rules for discovery and `build.rs` (via `#[path]`).

pub const MAX_NAME_CHARS: usize = 64;

pub fn validate_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(format!(
            "name must be 1–{MAX_NAME_CHARS} characters, got {}",
            name.chars().count()
        ));
    }
    if name.starts_with('-') || name.ends_with('-') {
        return Err("name must not start or end with '-'".to_string());
    }
    if name.contains("--") {
        return Err("name must not contain consecutive '--'".to_string());
    }
    if !name
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return Err("name may only contain lowercase letters, digits, and hyphens".to_string());
    }
    Ok(())
}
