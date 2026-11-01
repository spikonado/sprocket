use super::*;

#[test]
fn one_server_owns_a_profile_until_it_stops() {
    let dir = tempfile::tempdir().unwrap();
    let owner = ProfileLock::acquire(dir.path()).unwrap();
    assert!(ProfileLock::acquire(dir.path()).is_err());
    owner.publish("http://127.0.0.1:17731".into()).unwrap();
    assert_eq!(
        read_server_address(dir.path()).unwrap().as_deref(),
        Some("http://127.0.0.1:17731")
    );
    drop(owner);
    assert!(ProfileLock::acquire(dir.path()).is_ok());
}

#[cfg(windows)]
#[test]
fn private_files_stay_readable_and_unreadable_ones_are_removed_at_startup() {
    let dir = tempfile::tempdir().unwrap();
    let account_dir = dir.path().join("credentials").join("account");
    let private = account_dir.join("refresh-token");
    write_private_file(&private, b"token").unwrap();
    let locked_out = dir.path().join("sessions.json");
    std::fs::write(&locked_out, b"{}").unwrap();
    set_windows_dacl(&locked_out, "D:P").unwrap();

    let _owner = ProfileLock::acquire(dir.path()).unwrap();

    assert_eq!(std::fs::read(&private).unwrap(), b"token");
    assert!(!locked_out.exists());
}
