use super::*;

struct TestKeyring {
    token: std::sync::Mutex<Option<String>>,
    error: Option<fn() -> keyring::Error>,
}

impl TestKeyring {
    fn available(token: Option<&str>) -> Self {
        Self {
            token: std::sync::Mutex::new(token.map(str::to_string)),
            error: None,
        }
    }

    fn failing(error: fn() -> keyring::Error) -> Self {
        Self {
            token: std::sync::Mutex::new(None),
            error: Some(error),
        }
    }

    fn check(&self) -> anyhow::Result<()> {
        match self.error {
            Some(error) => Err(error()).context("keyring operation failed"),
            None => Ok(()),
        }
    }
}

impl RefreshTokenStore for TestKeyring {
    fn load(&self) -> anyhow::Result<Option<String>> {
        self.check()?;
        Ok(self.token.lock().unwrap().clone())
    }

    fn save(&self, token: &str) -> anyhow::Result<()> {
        self.check()?;
        *self.token.lock().unwrap() = Some(token.to_string());
        Ok(())
    }

    fn clear(&self) -> anyhow::Result<()> {
        self.check()?;
        *self.token.lock().unwrap() = None;
        Ok(())
    }
}

fn with_keyring(dir: &Path, keyring: TestKeyring) -> ProfileCredentials {
    let mut store = ProfileCredentials::new("https://test.convex.cloud", dir);
    store.keyring = Box::new(keyring);
    store
}

fn unavailable() -> keyring::Error {
    keyring::Error::PlatformFailure(std::io::Error::other("disconnected").into())
}

#[test]
fn keyring_credentials_are_scoped_to_deployment_and_data_directory() {
    let first = KeyringRefreshTokenStore::new("https://first.convex.cloud", Path::new("/one"));
    let same = KeyringRefreshTokenStore::new("https://first.convex.cloud", Path::new("/one"));
    let other_deployment =
        KeyringRefreshTokenStore::new("https://second.convex.cloud", Path::new("/one"));
    let other_data_dir =
        KeyringRefreshTokenStore::new("https://first.convex.cloud", Path::new("/two"));

    assert_eq!(first.account, same.account);
    assert_ne!(first.account, other_deployment.account);
    assert_ne!(first.account, other_data_dir.account);
}

#[test]
fn explicit_file_selection_survives_restart_and_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProfileCredentials::new("https://test.convex.cloud", dir.path());
    assert_eq!(store.selected().unwrap(), None);
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
fn automatic_storage_keeps_using_an_available_keyring() {
    let dir = tempfile::tempdir().unwrap();
    let store = with_keyring(dir.path(), TestKeyring::available(None));
    assert!(store.load().unwrap().is_none());
    store.save("keyring-session").unwrap();
    assert_eq!(store.load().unwrap().as_deref(), Some("keyring-session"));
    assert_eq!(store.selected().unwrap(), None);
    assert!(!store.token_path().exists());
    store.clear().unwrap();
    assert!(store.load().unwrap().is_none());
}

#[test]
fn unavailable_keyring_allows_sign_in_and_persists_file_storage() {
    let dir = tempfile::tempdir().unwrap();
    let store = with_keyring(dir.path(), TestKeyring::failing(unavailable));
    assert!(store.load().unwrap().is_none());
    store.save("signed-in").unwrap();
    assert_eq!(store.selected().unwrap(), Some(CredentialStore::File));

    let restarted = with_keyring(dir.path(), TestKeyring::failing(unavailable));
    assert_eq!(restarted.load().unwrap().as_deref(), Some("signed-in"));
    restarted.save("rotated").unwrap();
    assert_eq!(store.load().unwrap().as_deref(), Some("rotated"));
    restarted.clear().unwrap();
    assert!(store.load().unwrap().is_none());
}

#[test]
fn unavailable_keyring_allows_sign_out_without_restoring_stale_file_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let store = with_keyring(dir.path(), TestKeyring::failing(unavailable));
    write_private_file(&store.token_path(), b"stale-session").unwrap();
    store.clear().unwrap();
    assert_eq!(store.selected().unwrap(), Some(CredentialStore::File));
    assert!(store.load().unwrap().is_none());
}

#[test]
fn temporary_keyring_read_failure_does_not_change_storage_selection() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = with_keyring(dir.path(), TestKeyring::failing(unavailable));
    assert!(store.load().unwrap().is_none());
    assert_eq!(store.selected().unwrap(), None);
    store.keyring = Box::new(TestKeyring::available(Some("existing-keyring-session")));
    assert_eq!(
        store.load().unwrap().as_deref(),
        Some("existing-keyring-session")
    );
}

#[test]
fn explicit_keyring_selection_is_persisted_and_stays_strict() {
    let dir = tempfile::tempdir().unwrap();
    let store = with_keyring(dir.path(), TestKeyring::failing(unavailable));
    store.select(CredentialStore::Keyring).unwrap();
    assert_eq!(store.selected().unwrap(), Some(CredentialStore::Keyring));
    assert!(store.load().is_err());
    assert!(store.save("token").is_err());
    assert!(store.clear().is_err());
    assert!(!store.token_path().exists());
}

#[test]
fn keyring_data_errors_are_reported_without_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let store = with_keyring(
        dir.path(),
        TestKeyring::failing(|| keyring::Error::BadEncoding(vec![0xff])),
    );
    assert!(store.load().is_err());
    assert!(store.save("token").is_err());
    assert!(store.clear().is_err());
    assert_eq!(store.selected().unwrap(), None);
    assert!(!store.token_path().exists());
}

#[test]
fn failed_fallback_write_keeps_automatic_selection() {
    let dir = tempfile::tempdir().unwrap();
    let store = with_keyring(dir.path(), TestKeyring::failing(unavailable));
    std::fs::create_dir_all(store.token_path()).unwrap();
    std::fs::write(store.token_path().join("occupied"), b"").unwrap();
    assert!(store.save("token").is_err());
    assert_eq!(store.selected().unwrap(), None);
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
    std::fs::set_permissions(store.token_path(), std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(store.load().is_err());
    std::fs::remove_file(store.token_path()).unwrap();
    symlink("/etc/passwd", store.token_path()).unwrap();
    assert!(store.load().is_err());
}
