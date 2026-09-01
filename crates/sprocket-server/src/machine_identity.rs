use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::thread;
use std::time::Duration;

use anyhow::Context;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const INSTALLATION_ID_FILE: &str = "installation-id";
const INSTALLATION_IDENTITY_FILE: &str = "installation.json";
const INSTALLATION_IDENTITY_VERSION: u32 = 1;

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredInstallationIdentity {
    version: u32,
    installation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    friendly_name: Option<String>,
}

#[derive(Clone)]
pub(crate) struct MachineIdentity {
    pub(crate) installation_id: String,
    pub(crate) process_session_id: String,
    pub(crate) credential: String,
    pub(crate) credential_hash: String,
    pub(crate) friendly_name: String,
    pub(crate) platform: String,
    pub(crate) platform_version: String,
    pub(crate) architecture: String,
    pub(crate) hostname: String,
}

impl MachineIdentity {
    pub(crate) fn load(data_dir: &Path) -> anyhow::Result<Self> {
        let stored = load_or_create_installation_identity(data_dir)?;
        let credential = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let hostname = hostname();
        Ok(Self {
            installation_id: stored.installation_id,
            process_session_id: Uuid::new_v4().to_string(),
            credential_hash: Sha256::digest(credential.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
            credential,
            friendly_name: stored.friendly_name.unwrap_or_else(|| hostname.clone()),
            platform: normalized_platform().to_string(),
            platform_version: platform_version(),
            architecture: std::env::consts::ARCH.to_string(),
            hostname,
        })
    }
}

fn load_or_create_installation_identity(
    data_dir: &Path,
) -> anyhow::Result<StoredInstallationIdentity> {
    fs::create_dir_all(data_dir)
        .with_context(|| format!("failed to create data directory {}", data_dir.display()))?;
    let path = data_dir.join(INSTALLATION_IDENTITY_FILE);
    if let Some(identity) = read_installation_identity(&path)? {
        return Ok(identity);
    }

    let legacy_path = data_dir.join(INSTALLATION_ID_FILE);
    let installation_id =
        read_installation_id(&legacy_path)?.unwrap_or_else(|| Uuid::new_v4().to_string());
    let identity = StoredInstallationIdentity {
        version: INSTALLATION_IDENTITY_VERSION,
        installation_id,
        friendly_name: None,
    };
    let encoded = serde_json::to_vec_pretty(&identity)?;
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            file.write_all(&encoded).with_context(|| {
                format!("failed to write installation identity {}", path.display())
            })?;
            writeln!(file)?;
            file.sync_all().with_context(|| {
                format!("failed to persist installation identity {}", path.display())
            })?;
            Ok(identity)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            for _ in 0..10 {
                if let Some(identity) = read_installation_identity(&path)? {
                    return Ok(identity);
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(anyhow::anyhow!(
                "installation identity {} is invalid",
                path.display()
            ))
        }
        Err(error) => Err(error)
            .with_context(|| format!("failed to create installation identity {}", path.display())),
    }
}

fn read_installation_identity(path: &Path) -> anyhow::Result<Option<StoredInstallationIdentity>> {
    let value = match fs::read(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read {}", path.display()));
        }
    };
    let identity: StoredInstallationIdentity = match serde_json::from_slice(&value) {
        Ok(identity) => identity,
        Err(error) if error.is_eof() => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("invalid installation identity {}", path.display()));
        }
    };
    if identity.version != INSTALLATION_IDENTITY_VERSION
        || Uuid::parse_str(&identity.installation_id).is_err()
    {
        anyhow::bail!("unsupported installation identity {}", path.display());
    }
    Ok(Some(identity))
}

fn hostname() -> String {
    ["HOSTNAME", "COMPUTERNAME"]
        .into_iter()
        .find_map(|name| {
            std::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| "Sprocket machine".to_string())
}

fn normalized_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    }
}

fn platform_version() -> String {
    #[cfg(target_os = "windows")]
    let output = std::process::Command::new("cmd")
        .args(["/C", "ver"])
        .output();
    #[cfg(not(target_os = "windows"))]
    let output = std::process::Command::new("uname").arg("-r").output();
    output
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn read_installation_id(path: &Path) -> anyhow::Result<Option<String>> {
    let value = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| {
                format!("failed to read installation identity {}", path.display())
            });
        }
    };
    let value = value.trim();
    Ok(Uuid::parse_str(value).ok().map(|id| id.to_string()))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};

    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("sprocket-machine-identity-{}", Uuid::new_v4()))
    }

    fn identity_path(dir: &Path) -> PathBuf {
        dir.join(INSTALLATION_IDENTITY_FILE)
    }

    #[test]
    fn installation_id_persists_across_process_identities() {
        let dir = temp_dir();
        let first = MachineIdentity::load(&dir).unwrap();
        let second = MachineIdentity::load(&dir).unwrap();

        assert_eq!(first.installation_id, second.installation_id);
        assert_ne!(first.process_session_id, second.process_session_id);
        assert_ne!(first.credential, second.credential);
        assert!(identity_path(&dir).is_file());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migrates_legacy_plain_installation_id() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let id = Uuid::new_v4().to_string();
        fs::write(dir.join(INSTALLATION_ID_FILE), &id).unwrap();

        assert_eq!(MachineIdentity::load(&dir).unwrap().installation_id, id);
        assert!(identity_path(&dir).is_file());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn retains_friendly_name_override() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let identity = StoredInstallationIdentity {
            version: INSTALLATION_IDENTITY_VERSION,
            installation_id: Uuid::new_v4().to_string(),
            friendly_name: Some("Workbench".to_string()),
        };
        fs::write(identity_path(&dir), serde_json::to_vec(&identity).unwrap()).unwrap();

        assert_eq!(
            MachineIdentity::load(&dir).unwrap().friendly_name,
            "Workbench"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_first_loads_share_one_installation_id() {
        let dir = Arc::new(temp_dir());
        let barrier = Arc::new(Barrier::new(8));
        let threads = (0..8)
            .map(|_| {
                let dir = Arc::clone(&dir);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    MachineIdentity::load(&dir).unwrap().installation_id
                })
            })
            .collect::<Vec<_>>();
        let ids = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();

        assert!(ids.iter().all(|id| id == &ids[0]));
        fs::remove_dir_all(dir.as_ref()).unwrap();
    }
}
