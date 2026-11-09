use std::collections::BTreeMap;

include!(concat!(env!("OUT_DIR"), "/repo_env.rs"));

pub fn compile_time_env_var(key: &str) -> Option<&'static str> {
    COMPILE_TIME_ENV
        .iter()
        .find_map(|(candidate, value)| (*candidate == key).then_some(*value))
}

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
    for (key, value) in COMPILE_TIME_ENV {
        if std::env::var_os(key).is_none() {
            unsafe { std::env::set_var(key, value) };
        }
    }
}

#[cfg(test)]
mod tests;
