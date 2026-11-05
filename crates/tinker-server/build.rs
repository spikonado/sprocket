use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    generate_repo_env(&manifest_dir, &out_dir);
    generate_ports(&manifest_dir, &out_dir);
}

fn generate_repo_env(manifest_dir: &Path, out_dir: &Path) {
    let env_file = manifest_dir.join("../../.env");
    let env_file = env_file.canonicalize().unwrap_or(env_file);
    let generated_env = out_dir.join("repo_env.rs");

    println!("cargo:rerun-if-changed={}", env_file.display());

    let entries = dotenvy::from_path_iter(&env_file)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", env_file.display()))
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", env_file.display()));

    let mut generated = String::from("pub const COMPILE_TIME_ENV: &[(&str, &str)] = &[\n");
    for (key, value) in entries {
        if !key.starts_with("PUBLIC_") {
            continue;
        }
        generated.push_str("    (");
        generated.push_str(&format!("{key:?}"));
        generated.push_str(", ");
        generated.push_str(&format!("{value:?}"));
        generated.push_str("),\n");
    }
    generated.push_str("];\n");

    std::fs::write(generated_env, generated).expect("write generated repo env");
}

fn generate_ports(manifest_dir: &Path, out_dir: &Path) {
    let ports_file = manifest_dir.join("../../apps/desktop/ports.json");
    println!("cargo:rerun-if-changed={}", ports_file.display());

    let contents = std::fs::read_to_string(&ports_file)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", ports_file.display()));
    let ports: BTreeMap<String, u16> = serde_json::from_str(&contents)
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", ports_file.display()));
    let port = |name: &str| {
        *ports
            .get(name)
            .unwrap_or_else(|| panic!("{} is missing {name}", ports_file.display()))
    };

    let generated = format!(
        "pub const DEFAULT_PORT: u16 = {};\npub const DEFAULT_DEV_WEB_URL: &str = \"http://localhost:{}\";\n",
        port("installedApp"),
        port("webDev"),
    );
    std::fs::write(out_dir.join("ports.rs"), generated).expect("write generated ports");
}
