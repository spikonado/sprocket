use super::*;

impl AppState {
    pub(crate) fn for_test(
        auth: Arc<auth::AuthState>,
        native_auth: Arc<native_auth::NativeAuthManager>,
        data_dir: PathBuf,
        loopback_desktop_login_supported: bool,
        package_updates: Arc<package_update::PackageUpdateManager>,
    ) -> Self {
        let project_attachments =
            project_attachments::ProjectAttachmentStore::new(data_dir.clone());
        let transcript = TranscriptStore::new(data_dir.join("transcripts"));
        let transcript_watchers = TranscriptWatchers::new(
            "https://example.convex.cloud".to_string(),
            transcript.clone(),
            Arc::clone(&native_auth),
        );
        let artifact_watchers = ArtifactWatchers::new(
            "https://example.convex.cloud".to_string(),
            Arc::clone(&native_auth),
            data_dir.join("artifact-bindings"),
        );
        let workspace_search = workspace_search::WorkspaceSearchIndex::new();
        let machine_identity =
            Arc::new(machine_identity::MachineIdentity::load(&data_dir).expect("machine identity"));
        let chatgpt_credentials =
            chatgpt_credentials::ChatGptService::load_or_unavailable(&data_dir)
                .expect("ChatGPT credential service");
        let chatgpt_oauth = routes::chatgpt::PendingLogins::new(
            Arc::clone(&chatgpt_credentials),
            Arc::clone(&auth),
        );
        Self {
            lifetime: cli_sessions::ServerLifetime::new(false),
            auth,
            native_auth: Arc::clone(&native_auth),
            chatgpt_credentials,
            chatgpt_oauth,
            project_attachments,
            transcript,
            transcript_watchers,
            artifact_watchers,
            workspace_search: Arc::new(workspace_search),
            machines: machines::MachineManager::new(
                "https://example.convex.cloud".to_string(),
                Arc::clone(&native_auth),
                Arc::clone(&machine_identity),
            ),
            live_completions: Arc::new(LiveCompletionHub::new()),
            command_sessions: Arc::new(command_sessions::ThreadCommandSessions::default()),
            http_base_url: "http://127.0.0.1:7731".to_string(),
            loopback_desktop_login_supported,
            convex_deployment_url: "https://example.convex.cloud".to_string(),
            web_ui_enabled: true,
            desktop_bootstrap_token: None,
            machine_identity,
            run_recovery: run_recovery::RunRecovery::load(&data_dir).expect("run recovery store"),
            package_updates,
        }
    }
}
