use std::collections::BTreeMap;

include!(concat!(env!("OUT_DIR"), "/repo_env.rs"));

/// Return a public environment variable embedded from the repo `.env` at compile time.
pub fn compile_time_env_var(key: &str) -> Option<&'static str> {
    if !key.starts_with("PUBLIC_") {
        return None;
    }

    COMPILE_TIME_ENV
        .iter()
        .find_map(|(candidate, value)| (*candidate == key).then_some(*value))
}

/// Return the repo `.env` public variables known to this process.
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

/// Ensure public variables from the repo `.env` are available in the process environment.
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
        if !key.as_ref().starts_with("PUBLIC_") {
            continue;
        }
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
    fn compile_time_env_var_rejects_private_keys() {
        assert_eq!(compile_time_env_var("OPENAI_API_KEY"), None);
    }
}
