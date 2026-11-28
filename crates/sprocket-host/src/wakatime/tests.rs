use super::*;

#[tokio::test]
async fn ending_a_local_run_syncs_its_profile_with_the_configured_cli() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("fake wakatime-cli");
    std::fs::write(
        &executable,
        "#!/bin/sh\nprintf '%s\\n' \"$SPROCKET_DATA_DIR\" \"$@\" > \"$(dirname \"$0\")/invocation\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
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
