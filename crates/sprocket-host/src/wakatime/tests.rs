use super::*;

#[tokio::test]
async fn ending_a_local_run_syncs_its_profile_with_the_configured_cli() {
    let dir = tempfile::tempdir().unwrap();
    let executable = fake_cli(dir.path());
    let data_dir = dir.path().join("separate profile");
    let store = TranscriptStore::new(data_dir.join("transcripts"));
    let workspace = dir.path().join("project");
    for run_id in ["finished", "dropped"] {
        let session = WakaTimeSession::open(
            &store,
            "user",
            "thread",
            run_id,
            &workspace,
            executable.clone().into_os_string(),
        )
        .await
        .unwrap();
        if run_id == "finished" {
            session.finish().await;
        } else {
            let WakaTimeSession { finish, task } = session;
            drop(finish);
            task.await.unwrap();
        }

        let invocation = std::fs::read_to_string(dir.path().join("invocation")).unwrap();
        std::fs::remove_file(dir.path().join("invocation")).unwrap();
        let mut args = invocation.lines();
        assert_eq!(args.next(), data_dir.to_str());
        assert_eq!(args.next(), Some("--sync-ai-activity"));
        assert_eq!(args.next(), Some("--plugin"));
        assert!(args.next().unwrap().starts_with("Sprocket/"));

        let metadata: serde_json::Value = serde_json::from_slice(
            &std::fs::read(
                store
                    .thread_dir("user", "thread")
                    .join(format!("wakatime/{run_id}.json")),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(metadata["workspacePath"], workspace.to_str().unwrap());
    }
}

#[tokio::test(start_paused = true)]
async fn a_transcript_change_syncs_after_another_sync_releases_the_lock() {
    let dir = tempfile::tempdir().unwrap();
    let executable = fake_cli(dir.path());
    let (changes, receiver) = broadcast::channel(16);
    let (finish, stopped) = oneshot::channel();
    let lock = SYNC_LOCK.lock().await;
    let task = tokio::spawn(watch(
        executable.into_os_string(),
        dir.path().to_owned(),
        "user".into(),
        "thread".into(),
        receiver,
        stopped,
    ));
    changes.send(("user".into(), "thread".into())).unwrap();
    tokio::task::yield_now().await;
    tokio::time::advance(SYNC_INTERVAL).await;
    tokio::task::yield_now().await;
    tokio::time::resume();
    drop(lock);

    tokio::time::timeout(Duration::from_secs(5), async {
        while !dir.path().join("invocation").exists() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    finish.send(()).unwrap();
    task.await.unwrap();
}

fn fake_cli(dir: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let executable = dir.join("fake wakatime-cli");
    std::fs::write(
        &executable,
        "#!/bin/sh\nprintf '%s\\n' \"$SPROCKET_DATA_DIR\" \"$@\" > \"$(dirname \"$0\")/invocation\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    executable
}
