use std::path::{Path, PathBuf};

use anyhow::Context;
use sha2::{Digest, Sha256};

use super::CredentialStore;
use crate::profile::write_private_file;

const KEYRING_SERVICE: &str = "dev.sprocket.native-auth";
const KEYRING_ACCOUNT_PREFIX: &str = "workos-refresh-token";

pub(super) trait RefreshTokenStore: Send + Sync {
    fn select(&self, _store: CredentialStore) -> anyhow::Result<()> {
        anyhow::bail!("credential-store selection is unavailable")
    }
    fn load(&self) -> anyhow::Result<Option<String>>;
    fn save(&self, refresh_token: &str) -> anyhow::Result<()>;
    fn clear(&self) -> anyhow::Result<()>;
}

pub(super) struct KeyringRefreshTokenStore {
    account: String,
}

impl KeyringRefreshTokenStore {
    pub(super) fn new(deployment_url: &str, data_dir: &Path) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(deployment_url.as_bytes());
        hasher.update([0]);
        hasher.update(data_dir.as_os_str().as_encoded_bytes());
        let digest = hasher.finalize();
        let suffix = digest[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Self {
            account: format!("{KEYRING_ACCOUNT_PREFIX}-{suffix}"),
        }
    }

    fn entry(&self) -> anyhow::Result<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, &self.account)
            .context("failed to access the operating system credential store")
    }
}

impl RefreshTokenStore for KeyringRefreshTokenStore {
    fn load(&self) -> anyhow::Result<Option<String>> {
        match self.entry()?.get_password() {
            Ok(token) if token.trim().is_empty() => {
                anyhow::bail!("stored WorkOS refresh token is empty")
            }
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error).context("failed to load WorkOS refresh token"),
        }
    }

    fn save(&self, refresh_token: &str) -> anyhow::Result<()> {
        if refresh_token.trim().is_empty() {
            anyhow::bail!("refusing to persist an empty WorkOS refresh token");
        }
        self.entry()?
            .set_password(refresh_token)
            .context("failed to persist WorkOS refresh token")
    }

    fn clear(&self) -> anyhow::Result<()> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error).context("failed to delete WorkOS refresh token"),
        }
    }
}

pub(super) struct ProfileCredentials {
    keyring: Box<dyn RefreshTokenStore>,
    directory: PathBuf,
}

impl ProfileCredentials {
    pub fn new(deployment: &str, data_dir: &Path) -> Self {
        let keyring = KeyringRefreshTokenStore::new(deployment, data_dir);
        let directory = data_dir.join("credentials").join(&keyring.account);
        Self {
            keyring: Box::new(keyring),
            directory,
        }
    }

    fn selected(&self) -> anyhow::Result<Option<CredentialStore>> {
        match std::fs::read(self.directory.join("store.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .context("invalid credential-store selection"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn write_with_store<T>(
        &self,
        keyring: impl FnOnce(&dyn RefreshTokenStore) -> anyhow::Result<T>,
        file: impl FnOnce() -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        match self.selected()? {
            Some(CredentialStore::File) => file(),
            Some(CredentialStore::Keyring) => keyring(self.keyring.as_ref()),
            None => match keyring(self.keyring.as_ref()) {
                Err(error) if keyring_unavailable(&error) => {
                    let result = file()?;
                    self.write_selection(CredentialStore::File)?;
                    tracing::warn!(
                        "Operating system credential store is unavailable; using an unencrypted private file for this Sprocket profile"
                    );
                    Ok(result)
                }
                result => result,
            },
        }
    }

    fn write_selection(&self, store: CredentialStore) -> anyhow::Result<()> {
        write_private_file(
            &self.directory.join("store.json"),
            &serde_json::to_vec(&store)?,
        )
    }

    fn token_path(&self) -> PathBuf {
        self.directory.join("refresh-token")
    }

    fn load_file(&self) -> anyhow::Result<Option<String>> {
        let path = self.token_path();
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        anyhow::ensure!(metadata.is_file(), "credential file must be a regular file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            anyhow::ensure!(
                metadata.permissions().mode() & 0o077 == 0,
                "credential file must have owner-only permissions"
            );
        }
        let token = std::fs::read_to_string(path)?;
        anyhow::ensure!(!token.trim().is_empty(), "stored refresh token is empty");
        Ok(Some(token))
    }

    fn clear_file(&self) -> anyhow::Result<()> {
        match std::fs::remove_file(self.token_path()) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

impl RefreshTokenStore for ProfileCredentials {
    fn select(&self, store: CredentialStore) -> anyhow::Result<()> {
        if self.selected()?.unwrap_or_default() != store {
            match store {
                CredentialStore::Keyring => self.keyring.clear()?,
                CredentialStore::File => self.clear_file()?,
            }
        }
        self.write_selection(store)
    }

    fn load(&self) -> anyhow::Result<Option<String>> {
        match self.selected()? {
            Some(CredentialStore::File) => self.load_file(),
            Some(CredentialStore::Keyring) => self.keyring.load(),
            None => match self.keyring.load() {
                // A failed status read must not abandon a session in a temporarily unavailable keyring.
                Err(error) if keyring_unavailable(&error) => Ok(None),
                result => result,
            },
        }
    }

    fn save(&self, token: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            !token.trim().is_empty(),
            "refusing to store an empty refresh token"
        );
        self.write_with_store(
            |store| store.save(token),
            || write_private_file(&self.token_path(), token.as_bytes()),
        )
    }

    fn clear(&self) -> anyhow::Result<()> {
        self.write_with_store(|store| store.clear(), || self.clear_file())
    }
}

fn keyring_unavailable(error: &anyhow::Error) -> bool {
    matches!(
        error.downcast_ref::<keyring::Error>(),
        Some(
            keyring::Error::NoDefaultStore
                | keyring::Error::NoStorageAccess(_)
                | keyring::Error::PlatformFailure(_)
                | keyring::Error::NotSupportedByStore(_)
        )
    )
}

#[cfg(test)]
mod tests;
