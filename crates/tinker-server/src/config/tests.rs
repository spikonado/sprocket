use super::*;

#[test]
fn default_data_dir_prefers_tinker_then_legacy_sprocket() {
    let home = tempfile::tempdir().unwrap();
    let tinker = home.path().join(".tinker");
    let sprocket = home.path().join(".sprocket");

    assert_eq!(data_dir_in_home(home.path()), tinker);

    std::fs::create_dir(&sprocket).unwrap();
    assert_eq!(data_dir_in_home(home.path()), sprocket);

    std::fs::create_dir(&tinker).unwrap();
    assert_eq!(data_dir_in_home(home.path()), tinker);
}
