use super::*;

#[test]
fn default_data_dir_keeps_an_existing_sprocket_profile() {
    let home = tempfile::tempdir().unwrap();
    let sprocket = home.path().join(".sprocket");

    assert_eq!(data_dir_in_home(home.path()), home.path().join(".tinker"));

    std::fs::create_dir_all(home.path().join(".tinker/skills")).unwrap();
    std::fs::create_dir(&sprocket).unwrap();
    assert_eq!(data_dir_in_home(home.path()), sprocket);
}
