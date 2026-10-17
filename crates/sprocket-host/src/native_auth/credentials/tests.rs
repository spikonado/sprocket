use super::*;

struct TestKeyring {
    token: std::sync::Mutex<Option<String>>,
    load_error: Option<fn() -> keyring::Error>,
    save_error: Option<fn() -> keyring::Error>,
    clear_error: Option<fn() -> keyring::Error>,
}

impl TestKeyring {
    fn failing(error: fn() -> keyring::Error) -> Self {
        Self {
            token: std::sync::Mutex::new(None),
            load_error: Some(error),
            save_error: Some(error),
            clear_error: Some(error),
        }
    }
}

impl RefreshTokenStore for TestKeyring {
    fn load(&self) -> anyhow::Result<Option<String>> {
        if let Some(error) = self.load_error {
            return Err(error()).context("failed to load WorkOS refresh token");
        }
        Ok(self.token.lock().unwrap().clone())
    }

    fn save(&self, token: &str) -> anyhow::Result<()> {
        if let Some(error) = self.save_error {
            return Err(error()).context("failed to persist WorkOS refresh token");
        }
        *self.token.lock().unwrap() = Some(token.to_string());
        Ok(())
    }

    fn clear(&self) -> anyhow::Result<()> {
        if let Some(error) = self.clear_error {
            return Err(error()).context("failed to delete WorkOS refresh token");
        }
        *self.token.lock().unwrap() = None;
        Ok(())
    }
}

fn with_keyring(dir: &Path, keyring: TestKeyring) -> ProfileCredentials {
    let mut store = ProfileCredentials::new("https://test.convex.cloud", dir);
    store.keyring = Box::new(keyring);
    store
}

fn unavailable_errors() -> [fn() -> keyring::Error; 4] {
    [
        || keyring::Error::NoDefaultStore,
        || keyring::Error::NoStorageAccess(std::io::Error::other("locked").into()),
        || keyring::Error::PlatformFailure(std::io::Error::other("disconnected").into()),
        || keyring::Error::NotSupportedByStore("unsupported".into()),
    ]
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
    let store = with_keyring(
        dir.path(),
        TestKeyring {
            token: std::sync::Mutex::new(None),
            load_error: None,
            save_error: None,
            clear_error: None,
        },
    );
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
    for error in unavailable_errors() {
        let dir = tempfile::tempdir().unwrap();
        let store = with_keyring(dir.path(), TestKeyring::failing(error));
        assert!(store.load().unwrap().is_none());
        assert_eq!(store.selected().unwrap(), None);
        store.save("signed-in").unwrap();
        assert_eq!(store.selected().unwrap(), Some(CredentialStore::File));

        let restarted = ProfileCredentials::new("https://test.convex.cloud", dir.path());
        assert_eq!(restarted.load().unwrap().as_deref(), Some("signed-in"));
        restarted.save("rotated").unwrap();
        assert_eq!(store.load().unwrap().as_deref(), Some("rotated"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(store.token_path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        restarted.clear().unwrap();
        assert!(store.load().unwrap().is_none());
    }
}

#[test]
fn keyring_write_failure_falls_back_after_a_successful_read() {
    let dir = tempfile::tempdir().unwrap();
    let store = with_keyring(
        dir.path(),
        TestKeyring {
            token: std::sync::Mutex::new(Some("old-token".to_string())),
            load_error: None,
            save_error: Some(|| keyring::Error::NoDefaultStore),
            clear_error: None,
        },
    );
    assert_eq!(store.load().unwrap().as_deref(), Some("old-token"));
    store.save("rotated-token").unwrap();
    assert_eq!(store.load().unwrap().as_deref(), Some("rotated-token"));
}

#[test]
fn unavailable_keyring_allows_sign_out_without_restoring_stale_file_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let store = with_keyring(
        dir.path(),
        TestKeyring::failing(|| keyring::Error::NoDefaultStore),
    );
    write_private_file(&store.token_path(), b"stale-session").unwrap();
    store.clear().unwrap();
    assert_eq!(store.selected().unwrap(), Some(CredentialStore::File));
    assert!(store.load().unwrap().is_none());
}

#[test]
fn temporary_keyring_read_failure_does_not_change_storage_selection() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = with_keyring(
        dir.path(),
        TestKeyring::failing(|| keyring::Error::NoDefaultStore),
    );
    assert!(store.load().unwrap().is_none());
    assert_eq!(store.selected().unwrap(), None);
    store.keyring = Box::new(TestKeyring {
        token: std::sync::Mutex::new(Some("existing-keyring-session".to_string())),
        load_error: None,
        save_error: None,
        clear_error: None,
    });
    assert_eq!(
        store.load().unwrap().as_deref(),
        Some("existing-keyring-session")
    );
}

#[test]
fn explicit_keyring_selection_is_persisted_and_stays_strict() {
    for error in unavailable_errors() {
        let dir = tempfile::tempdir().unwrap();
        let store = with_keyring(dir.path(), TestKeyring::failing(error));
        store.select(CredentialStore::Keyring).unwrap();
        let restarted = with_keyring(dir.path(), TestKeyring::failing(error));
        assert_eq!(
            restarted.selected().unwrap(),
            Some(CredentialStore::Keyring)
        );
        assert!(restarted.load().is_err());
        assert!(restarted.save("token").is_err());
        assert!(restarted.clear().is_err());
        assert!(!restarted.token_path().exists());
    }
}

#[test]
fn credential_data_errors_are_preserved() {
    let errors: [fn() -> keyring::Error; 6] = [
        || keyring::Error::BadEncoding(vec![0xff]),
        || keyring::Error::BadDataFormat(vec![], std::io::Error::other("bad data").into()),
        || keyring::Error::BadStoreFormat("bad store".into()),
        || keyring::Error::Invalid("attribute".into(), "invalid".into()),
        || keyring::Error::TooLong("attribute".into(), 1),
        || keyring::Error::Ambiguous(vec![]),
    ];
    for error in errors {
        let dir = tempfile::tempdir().unwrap();
        let store = with_keyring(dir.path(), TestKeyring::failing(error));
        assert!(store.load().is_err());
        assert!(store.save("token").is_err());
        assert!(store.clear().is_err());
        assert_eq!(store.selected().unwrap(), None);
        assert!(!store.token_path().exists());
    }
}

#[test]
fn fallback_reports_file_persistence_failure() {
    let dir = tempfile::tempdir().unwrap();
    let store = with_keyring(
        dir.path(),
        TestKeyring::failing(|| keyring::Error::NoDefaultStore),
    );
    std::fs::create_dir_all(store.directory.parent().unwrap()).unwrap();
    std::fs::write(&store.directory, b"not a directory").unwrap();
    assert!(store.save("token").is_err());
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
