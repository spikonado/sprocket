use super::*;

#[test]
fn browser_launch_url_encodes_the_workspace() {
    assert_eq!(
        browser_launch_url("http://localhost:5173/", Some("/robot & tools")),
        "http://localhost:5173/#workspace=%2Frobot+%26+tools"
    );
}

#[test]
fn browser_launch_url_contains_no_pairing_material() {
    assert_eq!(
        browser_launch_url("http://127.0.0.1:17731", None),
        "http://127.0.0.1:17731"
    );
}
