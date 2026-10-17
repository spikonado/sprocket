use super::*;

async fn fixture_server(payload: &'static [u8]) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = axum::Router::new().route(
        "/binary",
        axum::routing::get(move || async move { payload }),
    );
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{address}/binary"), task)
}

#[tokio::test]
async fn publishes_verified_download_and_preserves_it_on_failed_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("agent-browser");
    let payload = b"verified browser executable";
    let asset = ReleaseAsset {
        asset: "fixture".into(),
        bytes: payload.len() as u64,
        sha256: hex::encode(Sha256::digest(payload)),
    };
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let (url, server) = fixture_server(payload).await;
    download_atomic(&client, &url, &asset, &path).await.unwrap();
    assert!(verified_file(&path, &asset).await.unwrap());
    assert_eq!(tokio::fs::read(&path).await.unwrap(), payload);
    server.abort();
    let (url, server) = fixture_server(b"corrupt browser executable!").await;
    assert!(download_atomic(&client, &url, &asset, &path).await.is_err());
    assert!(verified_file(&path, &asset).await.unwrap());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    server.abort();
}

#[tokio::test]
async fn rejects_partial_download_before_publication() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("agent-browser");
    let asset = ReleaseAsset {
        asset: "fixture".into(),
        bytes: 100,
        sha256: "unused".into(),
    };
    let (url, server) = fixture_server(b"partial").await;
    assert!(
        download_atomic(
            &reqwest::Client::builder().no_proxy().build().unwrap(),
            &url,
            &asset,
            &path
        )
        .await
        .is_err()
    );
    assert!(!path.exists());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    server.abort();
}

#[test]
fn prunes_other_versions_and_keeps_current_and_unrelated_entries() {
    let directory = tempfile::tempdir().unwrap();
    let tool = directory.path();
    for path in [
        "0.38.2/linux-musl-x64",
        "0.37.0/linux-musl-x64",
        "0.36.1/skill-data/core",
        "cache",
        ".0.35.0.42.removing/linux-musl-x64",
    ] {
        std::fs::create_dir_all(tool.join(path)).unwrap();
    }
    std::fs::write(tool.join("0.37.0/install.lock"), b"").unwrap();
    std::fs::write(tool.join("0.37.0/linux-musl-x64/agent-browser"), b"old").unwrap();
    std::fs::write(tool.join("0.36.1/skill-data/core/SKILL.md"), b"old").unwrap();
    std::fs::write(tool.join("1.0.0"), b"not a directory").unwrap();

    prune_versions(tool, "0.38.2");

    let mut remaining: Vec<_> = std::fs::read_dir(tool)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    remaining.sort();
    assert_eq!(remaining, ["0.38.2", "1.0.0", "cache"]);
}

#[test]
fn keeps_versions_held_by_an_installer_or_a_lease() {
    let directory = tempfile::tempdir().unwrap();
    let tool = directory.path();
    std::fs::create_dir_all(tool.join("0.36.0")).unwrap();
    std::fs::create_dir_all(tool.join("0.37.0")).unwrap();
    let installing = open_lock_file(&tool.join("0.36.0").join(INSTALL_LOCK)).unwrap();
    installing.lock().unwrap();
    let lease = open_lock_file(&tool.join("0.37.0").join(LEASE_LOCK)).unwrap();
    lease.lock_shared().unwrap();

    prune_versions(tool, "0.38.2");
    assert!(tool.join("0.36.0").is_dir());
    assert!(tool.join("0.37.0").is_dir());

    drop(installing);
    drop(lease);
    prune_versions(tool, "0.38.2");
    assert_eq!(std::fs::read_dir(tool).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn ignores_symlinked_versions() {
    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("keep"), b"").unwrap();
    std::os::unix::fs::symlink(outside.path(), directory.path().join("0.37.0")).unwrap();

    prune_versions(directory.path(), "0.38.2");

    assert!(directory.path().join("0.37.0").exists());
    assert!(outside.path().join("keep").exists());
}
