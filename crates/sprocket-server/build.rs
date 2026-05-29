use std::path::PathBuf;

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let env_file = manifest_dir.join("../../.env");
    let env_file = env_file.canonicalize().unwrap_or(env_file);
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let generated_env = out_dir.join("repo_env.rs");

    println!("cargo:rerun-if-changed={}", env_file.display());

    let entries = dotenvy::from_path_iter(&env_file)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", env_file.display()))
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", env_file.display()));

    let mut generated = String::from("pub const COMPILE_TIME_ENV: &[(&str, &str)] = &[\n");
    for (key, value) in entries {
        generated.push_str("    (");
        generated.push_str(&format!("{key:?}"));
        generated.push_str(", ");
        generated.push_str(&format!("{value:?}"));
        generated.push_str("),\n");
    }
    generated.push_str("];\n");

    std::fs::write(generated_env, generated).expect("write generated repo env");
}
