use std::collections::BTreeMap;

include!(concat!(env!("OUT_DIR"), "/repo_env.rs"));

/// Return an environment variable embedded from the repo `.env` at compile time.
pub fn compile_time_env_var(key: &str) -> Option<&'static str> {
    COMPILE_TIME_ENV
        .iter()
        .find_map(|(candidate, value)| (*candidate == key).then_some(*value))
}

/// Return the repo `.env` variables known to this process.
///
/// Values from the actual process environment win over embedded defaults so
/// callers still honor explicit runtime overrides.
pub fn repo_env_vars() -> BTreeMap<String, String> {
    let mut entries = BTreeMap::new();

    for (key, value) in COMPILE_TIME_ENV {
        entries.insert((*key).to_string(), (*value).to_string());
    }

    for (key, value) in entries.iter_mut() {
        if let Ok(runtime_value) = std::env::var(key) {
            *value = runtime_value;
        }
    }

    entries
}

/// Ensure variables from the repo `.env` are available in the process environment.
///
/// # Safety
///
/// Must run during single-threaded startup before other threads read the environment.
pub unsafe fn load_repo_env() {
    apply_env_entries(COMPILE_TIME_ENV);
}

fn apply_env_entries<K, V>(entries: &[(K, V)])
where
    K: AsRef<str>,
    V: AsRef<str>,
{
    for (key, value) in entries {
        if std::env::var(key.as_ref()).is_err() {
            // SAFETY: callers guarantee single-threaded startup.
            unsafe {
                std::env::set_var(key.as_ref(), value.as_ref());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compile_time_or_repo_dotenv_provides_public_convex_url() {
        let url = compile_time_env_var("PUBLIC_CONVEX_URL");
        assert!(
            url.is_some_and(|value| !value.is_empty()),
            "expected PUBLIC_CONVEX_URL in compile-time env"
        );
    }

    #[test]
    fn repo_env_vars_include_compile_time_entries() {
        let entries = repo_env_vars();
        assert!(entries.contains_key("PUBLIC_CONVEX_URL"));
    }
}
