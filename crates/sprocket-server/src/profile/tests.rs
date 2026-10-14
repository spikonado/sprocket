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
