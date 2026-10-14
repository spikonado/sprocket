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
    std::fs::set_permissions(store.token_path(), std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(store.load().is_err());
    std::fs::remove_file(store.token_path()).unwrap();
    symlink("/etc/passwd", store.token_path()).unwrap();
    assert!(store.load().is_err());
}
