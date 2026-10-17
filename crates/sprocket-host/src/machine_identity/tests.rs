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
    assert_ne!(first.credential, second.credential);
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
