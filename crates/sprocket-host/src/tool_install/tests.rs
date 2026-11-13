use std::io::Cursor;

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
async fn installs_the_pinned_version_into_bin_and_prunes_others() {
    let payload = b"tool executable";
    let (url, server) = fixture_server(payload).await;
    let data_dir = tempfile::tempdir().unwrap();
    let old_version = data_dir.path().join("tools/tool/0.9.0");
    std::fs::create_dir_all(&old_version).unwrap();
    let releases = serde_json::json!({
        "version": "1.0.0",
        "platforms": {
            release_platform().unwrap(): {
                "url": url,
                "bytes": payload.len(),
                "sha256": hex::encode(Sha256::digest(payload)),
            },
        },
    });
    let mut tool = PinnedTool::new(
        data_dir.path(),
        "tool",
        &releases.to_string(),
        |download, bin| {
            std::fs::copy(download, bin.join("tool"))?;
            Ok(())
        },
    )
    .unwrap();
    tool.client = reqwest::Client::builder().no_proxy().build().unwrap();

    tool.ensure_installed().await.unwrap();

    assert_eq!(std::fs::read(tool.bin_dir().join("tool")).unwrap(), payload);
    let mut entries: Vec<_> = std::fs::read_dir(tool.version_dir())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    entries.sort();
    assert_eq!(entries, ["bin", LEASE_LOCK, INSTALL_LOCK]);
    assert!(!old_version.exists());
    server.abort();
}

#[tokio::test]
async fn publishes_verified_download_and_preserves_it_on_failed_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("agent-browser");
    let payload = b"verified browser executable";
    let checksum = Checksum {
        bytes: payload.len() as u64,
        sha256: hex::encode(Sha256::digest(payload)),
    };
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let (url, server) = fixture_server(payload).await;
    download_atomic(&client, &url, &checksum, &path)
        .await
        .unwrap();
    assert_eq!(tokio::fs::read(&path).await.unwrap(), payload);
    server.abort();
    let (url, server) = fixture_server(b"corrupt browser executable!").await;
    assert!(
        download_atomic(&client, &url, &checksum, &path)
            .await
            .is_err()
    );
    assert_eq!(tokio::fs::read(&path).await.unwrap(), payload);
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    server.abort();
}

#[tokio::test]
async fn rejects_partial_download_before_publication() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("agent-browser");
    let checksum = Checksum {
        bytes: 100,
        sha256: "unused".into(),
    };
    let (url, server) = fixture_server(b"partial").await;
    assert!(
        download_atomic(
            &reqwest::Client::builder().no_proxy().build().unwrap(),
            &url,
            &checksum,
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

#[test]
fn appends_after_the_users_path_and_moves_windows_store_aliases_last() {
    let (store, user, tools) = (
        PathBuf::from("Microsoft/WindowsApps"),
        PathBuf::from("user"),
        PathBuf::from("tools"),
    );
    let path = std::env::join_paths([&store, &user]).unwrap();

    let environment = append_path(vec![("PATH".into(), path)], [tools.clone()]);

    let expected = if cfg!(windows) {
        [user, tools, store]
    } else {
        [store, user, tools]
    };
    assert_eq!(
        std::env::split_paths(&environment[0].1).collect::<Vec<_>>(),
        expected
    );
}

fn write_zip_with_uncompressed_sizes(path: &Path, sizes: &[u32]) {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for index in 0..sizes.len() {
        writer
            .start_file(
                format!("f{index}"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
    }
    let mut data = writer.finish().unwrap().into_inner();
    let eocd = data
        .windows(4)
        .rposition(|magic| magic == [0x50, 0x4b, 0x05, 0x06])
        .unwrap();
    let mut pos = u32::from_le_bytes(data[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
    for &size in sizes {
        assert_eq!(&data[pos..pos + 4], b"PK\x01\x02");
        let name_len = u16::from_le_bytes(data[pos + 28..pos + 30].try_into().unwrap()) as usize;
        let extra_len = u16::from_le_bytes(data[pos + 30..pos + 32].try_into().unwrap()) as usize;
        let comment_len = u16::from_le_bytes(data[pos + 32..pos + 34].try_into().unwrap()) as usize;
        let local = u32::from_le_bytes(data[pos + 42..pos + 46].try_into().unwrap()) as usize;
        assert_eq!(&data[local..local + 4], b"PK\x03\x04");
        data[pos + 24..pos + 28].copy_from_slice(&size.to_le_bytes());
        data[local + 22..local + 26].copy_from_slice(&size.to_le_bytes());
        pos += 46 + name_len + extra_len + comment_len;
    }
    std::fs::write(path, data).unwrap();
}

fn zip_limit() -> u32 {
    u32::try_from(MAX_ZIP_UNCOMPRESSED).unwrap()
}

#[test]
fn opens_a_zip_at_the_uncompressed_size_limit() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("tool.zip");
    write_zip_with_uncompressed_sizes(&archive, &[zip_limit()]);

    open_zip(&archive).unwrap();
}

#[test]
fn rejects_a_zip_one_byte_over_the_uncompressed_size_limit() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("tool.zip");
    write_zip_with_uncompressed_sizes(&archive, &[zip_limit() + 1]);

    let error = open_zip(&archive).unwrap_err().to_string();
    assert!(error.contains("exceeds"));
}

#[test]
fn rejects_a_zip_whose_entries_sum_over_the_uncompressed_size_limit() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("tool.zip");
    let half = zip_limit() / 2 + 1;
    write_zip_with_uncompressed_sizes(&archive, &[half, half]);

    let error = open_zip(&archive).unwrap_err().to_string();
    assert!(error.contains("exceeds"));
}
