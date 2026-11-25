use std::collections::HashMap;

use super::*;

#[derive(Default)]
struct MemoryKeyStore(Mutex<HashMap<String, Vec<u8>>>);

impl KeyStore for MemoryKeyStore {
    fn load(&self, key_id: &str) -> keyring::Result<Vec<u8>> {
        self.0
            .lock()
            .unwrap()
            .get(key_id)
            .cloned()
            .ok_or(keyring::Error::NoEntry)
    }

    fn save(&self, key_id: &str, key: &[u8]) -> keyring::Result<()> {
        self.0
            .lock()
            .unwrap()
            .insert(key_id.to_owned(), key.to_vec());
        Ok(())
    }
}

#[test]
fn plain_file_is_sealed_on_write_and_reads_back_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("secret.json");
    std::fs::write(&path, b"plain secret").unwrap();
    let keys: Arc<MemoryKeyStore> = Arc::default();

    let file = SealedFile::new(path.clone(), keys.clone());
    assert_eq!(file.read().unwrap().unwrap(), b"plain secret");
    file.write(b"new secret").unwrap();
    let on_disk = std::fs::read(&path).unwrap();
    assert!(!on_disk.windows(6).any(|window| window == b"secret"));

    let restarted = SealedFile::new(path, keys);
    assert_eq!(restarted.read().unwrap().unwrap(), b"new secret");
    restarted.write(b"newer secret").unwrap();
    assert!(
        serde_json::from_slice::<Envelope>(&std::fs::read(restarted.path.as_path()).unwrap())
            .is_ok()
    );
}

#[test]
fn sealed_file_fails_to_read_when_locked_or_tampered() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("secret.json");
    let keys: Arc<MemoryKeyStore> = Arc::default();
    SealedFile::new(path.clone(), keys.clone())
        .write(b"secret")
        .unwrap();

    assert!(
        SealedFile::new(path.clone(), Arc::new(UnavailableKeyStore))
            .read()
            .is_err()
    );

    let mut envelope: Envelope = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    envelope.data.replace_range(..4, "AAAA");
    std::fs::write(&path, serde_json::to_vec(&envelope).unwrap()).unwrap();
    assert!(SealedFile::new(path, keys).read().is_err());
}

#[test]
fn sealed_file_without_its_key_reads_as_missing() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("secret.json");
    SealedFile::new(path.clone(), Arc::new(MemoryKeyStore::default()))
        .write(b"secret")
        .unwrap();

    let file = SealedFile::new(path, Arc::new(MemoryKeyStore::default()));
    assert!(file.read().unwrap().is_none());
}
