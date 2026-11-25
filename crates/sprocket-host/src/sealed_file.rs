use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::Context;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::profile::write_private_file;

const KEYRING_SERVICE: &str = "dev.sprocket.sealed-file";
const KEY_LEN: usize = 32;
const FORMAT_VERSION: u32 = 1;

pub(crate) trait KeyStore: Send + Sync {
    fn load(&self, key_id: &str) -> keyring::Result<Vec<u8>>;
    fn save(&self, key_id: &str, key: &[u8]) -> keyring::Result<()>;
}

struct OsKeyStore;

impl KeyStore for OsKeyStore {
    fn load(&self, key_id: &str) -> keyring::Result<Vec<u8>> {
        keyring::Entry::new(KEYRING_SERVICE, key_id)?.get_secret()
    }

    fn save(&self, key_id: &str, key: &[u8]) -> keyring::Result<()> {
        keyring::Entry::new(KEYRING_SERVICE, key_id)?.set_secret(key)
    }
}

struct UnavailableKeyStore;

impl KeyStore for UnavailableKeyStore {
    fn load(&self, _key_id: &str) -> keyring::Result<Vec<u8>> {
        Err(keyring::Error::NoDefaultStore)
    }

    fn save(&self, _key_id: &str, _key: &[u8]) -> keyring::Result<()> {
        Err(keyring::Error::NoDefaultStore)
    }
}

/// Tests must not write to the developer's real keyring.
pub(crate) fn os_key_store() -> Arc<dyn KeyStore> {
    if cfg!(any(test, feature = "test-support")) {
        Arc::new(UnavailableKeyStore)
    } else {
        Arc::new(OsKeyStore)
    }
}

pub(crate) fn keyring_unavailable(error: &keyring::Error) -> bool {
    matches!(
        error,
        keyring::Error::NoDefaultStore
            | keyring::Error::NoStorageAccess(_)
            | keyring::Error::PlatformFailure(_)
            | keyring::Error::NotSupportedByStore(_)
    )
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    sealed: u32,
    key_id: String,
    data: String,
}

enum KeyState {
    Unresolved,
    Unavailable,
    Ready {
        id: String,
        key: Box<LessSafeKey>,
    },
}

/// A private file encrypted with a key held in the operating system keyring. Without a usable
/// keyring it stays a plain owner-only file, but once sealed it never goes back to plain text.
pub(crate) struct SealedFile {
    path: PathBuf,
    keys: Arc<dyn KeyStore>,
    state: Mutex<KeyState>,
}

impl SealedFile {
    pub(crate) fn new(path: PathBuf, keys: Arc<dyn KeyStore>) -> Self {
        Self {
            path,
            keys,
            state: Mutex::new(KeyState::Unresolved),
        }
    }

    /// Returns `None` for a missing file, and for a file sealed with a key the keyring no longer
    /// has, since nothing can recover its contents.
    pub(crate) fn read(&self) -> anyhow::Result<Option<Vec<u8>>> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let Ok(envelope) = serde_json::from_slice::<Envelope>(&bytes) else {
            return Ok(Some(bytes));
        };
        anyhow::ensure!(
            envelope.sealed == FORMAT_VERSION,
            "unsupported sealed file version"
        );
        let raw = match self.keys.load(&envelope.key_id) {
            Ok(raw) => raw,
            Err(keyring::Error::NoEntry) => {
                tracing::warn!(
                    "The keyring no longer has the key for {}; discarding its contents",
                    self.path.display()
                );
                return Ok(None);
            }
            Err(error) => {
                return Err(error).context(
                    "could not read the encryption key from the operating system keyring; unlock it and restart Sprocket",
                );
            }
        };
        let key = aead_key(&raw)?;
        let plaintext = open(&key, &envelope)?;
        *self.lock() = KeyState::Ready {
            id: envelope.key_id,
            key: Box::new(key),
        };
        Ok(Some(plaintext))
    }

    pub(crate) fn write(&self, plaintext: &[u8]) -> anyhow::Result<()> {
        let mut state = self.lock();
        if matches!(*state, KeyState::Unresolved) {
            *state = self.create_key()?;
        }
        match &*state {
            KeyState::Ready { id, key } => {
                write_private_file(&self.path, &serde_json::to_vec(&seal(id, key, plaintext)?)?)
            }
            KeyState::Unavailable | KeyState::Unresolved => {
                write_private_file(&self.path, plaintext)
            }
        }
    }

    fn create_key(&self) -> anyhow::Result<KeyState> {
        let raw = random::<KEY_LEN>()?;
        let id = Uuid::new_v4().to_string();
        match self.keys.save(&id, &raw) {
            Ok(()) => Ok(KeyState::Ready {
                key: Box::new(aead_key(&raw)?),
                id,
            }),
            Err(error) if keyring_unavailable(&error) => {
                tracing::warn!(
                    "Operating system credential store is unavailable; keeping {} as an unencrypted private file",
                    self.path.display()
                );
                Ok(KeyState::Unavailable)
            }
            Err(error) => Err(error).context("could not save an encryption key to the keyring"),
        }
    }

    fn lock(&self) -> MutexGuard<'_, KeyState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}

fn random<const N: usize>() -> anyhow::Result<[u8; N]> {
    let mut bytes = [0; N];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| anyhow::anyhow!("the system random number generator failed"))?;
    Ok(bytes)
}

fn aead_key(raw: &[u8]) -> anyhow::Result<LessSafeKey> {
    let key = UnboundKey::new(&AES_256_GCM, raw)
        .map_err(|_| anyhow::anyhow!("the keyring holds an invalid encryption key"))?;
    Ok(LessSafeKey::new(key))
}

fn seal(id: &str, key: &LessSafeKey, plaintext: &[u8]) -> anyhow::Result<Envelope> {
    let nonce = random::<NONCE_LEN>()?;
    let mut data = plaintext.to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(id.as_bytes()),
        &mut data,
    )
    .map_err(|_| anyhow::anyhow!("could not encrypt the file"))?;
    Ok(Envelope {
        sealed: FORMAT_VERSION,
        key_id: id.to_owned(),
        data: STANDARD.encode([nonce.as_slice(), &data].concat()),
    })
}

fn open(key: &LessSafeKey, envelope: &Envelope) -> anyhow::Result<Vec<u8>> {
    let corrupt = || anyhow::anyhow!("the sealed file is corrupt");
    let mut data = STANDARD.decode(&envelope.data).map_err(|_| corrupt())?;
    anyhow::ensure!(data.len() >= NONCE_LEN, corrupt());
    let (nonce, sealed) = data.split_at_mut(NONCE_LEN);
    let nonce = Nonce::try_assume_unique_for_key(nonce).map_err(|_| corrupt())?;
    let plaintext = key
        .open_in_place(nonce, Aad::from(envelope.key_id.as_bytes()), sealed)
        .map_err(|_| anyhow::anyhow!("the sealed file does not match its keyring key"))?;
    Ok(plaintext.to_vec())
}

#[cfg(test)]
mod tests;
