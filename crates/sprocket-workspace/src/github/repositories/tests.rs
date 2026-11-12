use super::{clone_url, directory_name};

#[test]
fn clone_sources_resolve_to_url_and_directory() {
    for (source, url, directory) in [
        ("octo/hello", "https://github.com/octo/hello.git", "hello"),
        (
            "https://github.com/octo/hello/",
            "https://github.com/octo/hello/",
            "hello",
        ),
        (
            "git@github.com:octo/hello.git",
            "git@github.com:octo/hello.git",
            "hello",
        ),
    ] {
        let resolved = clone_url(source).unwrap();
        assert_eq!(resolved, url);
        assert_eq!(directory_name(&resolved).unwrap(), directory);
    }
}
