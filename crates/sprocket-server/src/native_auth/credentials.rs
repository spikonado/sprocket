use std::path::{Path, PathBuf};

use anyhow::Context;
use sha2::{Digest, Sha256};

use crate::cli_protocol::CredentialStore;
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

#[cfg(test)]
pub(super) struct EmptyRefreshTokenStore;

#[cfg(test)]
impl RefreshTokenStore for EmptyRefreshTokenStore {
    fn load(&self) -> anyhow::Result<Option<String>> {
        Ok(None)
    }

    fn save(&self, _refresh_token: &str) -> anyhow::Result<()> {
        Ok(())
    }

    fn clear(&self) -> anyhow::Result<()> {
        Ok(())
    }
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

    #[cfg(test)]
    pub(super) fn account(&self) -> &str {
        &self.account
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
    keyring: KeyringRefreshTokenStore,
    directory: PathBuf,
}

impl ProfileCredentials {
    pub fn new(deployment: &str, data_dir: &Path) -> Self {
        let keyring = KeyringRefreshTokenStore::new(deployment, data_dir);
        let directory = data_dir.join("credentials").join(&keyring.account);
        Self { keyring, directory }
    }

    fn selected(&self) -> anyhow::Result<CredentialStore> {
        match std::fs::read(self.directory.join("store.json")) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).context("invalid credential-store selection")
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(CredentialStore::Keyring)
            }
            Err(error) => Err(error.into()),
        }
    }

    fn token_path(&self) -> PathBuf {
        self.directory.join("refresh-token")
    }
}

impl RefreshTokenStore for ProfileCredentials {
    fn select(&self, store: CredentialStore) -> anyhow::Result<()> {
        if self.selected()? != store {
            match store {
                CredentialStore::Keyring => self.keyring.clear()?,
                CredentialStore::File => match std::fs::remove_file(self.token_path()) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                },
            }
            write_private_file(
                &self.directory.join("store.json"),
                &serde_json::to_vec(&store)?,
            )?;
        }
        Ok(())
    }

    fn load(&self) -> anyhow::Result<Option<String>> {
        match self.selected()? {
            CredentialStore::Keyring => self.keyring.load(),
            CredentialStore::File => {
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
        }
    }

    fn save(&self, token: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            !token.trim().is_empty(),
            "refusing to store an empty refresh token"
        );
        match self.selected()? {
            CredentialStore::Keyring => self.keyring.save(token),
            CredentialStore::File => write_private_file(&self.token_path(), token.as_bytes()),
        }
    }

    fn clear(&self) -> anyhow::Result<()> {
        match self.selected()? {
            CredentialStore::Keyring => self.keyring.clear(),
            CredentialStore::File => match std::fs::remove_file(self.token_path()) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.into()),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_file_selection_survives_restart_and_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProfileCredentials::new("https://test.convex.cloud", dir.path());
        assert_eq!(store.selected().unwrap(), CredentialStore::Keyring);
        store.select(CredentialStore::File).unwrap();
        store.save("first").unwrap();
        let restarted = ProfileCredentials::new("https://test.convex.cloud", dir.path());
        assert_eq!(restarted.load().unwrap().as_deref(), Some("first"));
        restarted.save("rotated").unwrap();
        assert_eq!(store.load().unwrap().as_deref(), Some("rotated"));
        restarted.clear().unwrap();
        assert!(store.load().unwrap().is_none());
    }

    #[test]
    fn switching_back_to_file_storage_does_not_restore_an_old_login() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProfileCredentials::new("https://test.convex.cloud", dir.path());
        store.select(CredentialStore::File).unwrap();
        store.save("old-session").unwrap();
        write_private_file(&store.directory.join("store.json"), b"\"keyring\"").unwrap();
        store.select(CredentialStore::File).unwrap();
        assert!(store.load().unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_shared_permissions_and_symlinks() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = tempfile::tempdir().unwrap();
        let store = ProfileCredentials::new("https://test.convex.cloud", dir.path());
        store.select(CredentialStore::File).unwrap();
        store.save("secret").unwrap();
        std::fs::set_permissions(store.token_path(), std::fs::Permissions::from_mode(0o644))
            .unwrap();
        assert!(store.load().is_err());
        std::fs::remove_file(store.token_path()).unwrap();
        symlink("/etc/passwd", store.token_path()).unwrap();
        assert!(store.load().is_err());
    }
}
