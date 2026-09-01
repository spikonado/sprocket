use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::thread;
use std::time::Duration;

use anyhow::Context;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const INSTALLATION_ID_FILE: &str = "installation-id";

#[derive(Clone)]
pub(crate) struct MachineIdentity {
    pub(crate) installation_id: String,
    pub(crate) process_session_id: String,
    pub(crate) credential: String,
    pub(crate) credential_hash: String,
    pub(crate) friendly_name: String,
    pub(crate) platform: String,
    pub(crate) architecture: String,
}

impl MachineIdentity {
    pub(crate) fn load(data_dir: &Path) -> anyhow::Result<Self> {
        let installation_id = load_or_create_installation_id(data_dir)?;
        let credential = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        Ok(Self {
            installation_id,
            process_session_id: Uuid::new_v4().to_string(),
            credential_hash: Sha256::digest(credential.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
            credential,
            friendly_name: std::env::var("HOSTNAME")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Sprocket machine".to_string()),
            platform: std::env::consts::OS.to_string(),
            architecture: std::env::consts::ARCH.to_string(),
        })
    }
}

fn load_or_create_installation_id(data_dir: &Path) -> anyhow::Result<String> {
    fs::create_dir_all(data_dir)
        .with_context(|| format!("failed to create data directory {}", data_dir.display()))?;
    let path = data_dir.join(INSTALLATION_ID_FILE);
    if let Some(id) = read_installation_id(&path)? {
        return Ok(id);
    }

    let id = Uuid::new_v4().to_string();
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            writeln!(file, "{id}").with_context(|| {
                format!("failed to write installation identity {}", path.display())
            })?;
            file.sync_all().with_context(|| {
                format!("failed to persist installation identity {}", path.display())
            })?;
            Ok(id)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            for _ in 0..10 {
                if let Some(id) = read_installation_id(&path)? {
                    return Ok(id);
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
    use std::sync::{Arc, Barrier};

    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("sprocket-machine-identity-{}", Uuid::new_v4()))
    }

    #[test]
    fn installation_id_persists_across_process_identities() {
        let dir = temp_dir();
        let first = MachineIdentity::load(&dir).unwrap();
        let second = MachineIdentity::load(&dir).unwrap();

        assert_eq!(first.installation_id, second.installation_id);
        assert_ne!(first.process_session_id, second.process_session_id);
        assert_ne!(first.credential, second.credential);
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
