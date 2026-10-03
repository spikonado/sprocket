use std::sync::Arc;

use sprocket_agent::subagents::{
    SharedSubagentLauncher, SubagentLaunchHandle, SubagentLaunchRequest, SubagentLauncher,
};

use crate::AppState;
use crate::routes::agent::{RunAgentApiRequest, WorkspaceAccess, launch_agent};

pub(crate) struct NativeSubagentLauncher {
    state: AppState,
}

pub(crate) fn launcher(state: &AppState) -> SharedSubagentLauncher {
    Arc::new(NativeSubagentLauncher {
        state: state.clone(),
    })
}

impl SubagentLauncher for NativeSubagentLauncher {
    fn launch(
        &self,
        request: SubagentLaunchRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<SubagentLaunchHandle>> + Send + '_>,
    > {
        Box::pin(self.launch_child(request))
    }
}

impl NativeSubagentLauncher {
    async fn launch_child(
        &self,
        request: SubagentLaunchRequest,
    ) -> anyhow::Result<SubagentLaunchHandle> {
        let state = self.state.clone();
        let cancellation = sprocket_workspace::WorkspaceCancellation::new();
        let payload = launch_payload(request);
        let handle = launch_agent(
            state,
            payload,
            WorkspaceAccess::RunDirectory,
            true,
            cancellation,
            None,
        )
        .await
        .map_err(|error| anyhow::anyhow!("failed to launch subagent: {error}"))?;

        Ok(SubagentLaunchHandle {
            run_id: handle.run_id,
            thread_id: handle.thread_id,
        })
    }
}

fn launch_payload(request: SubagentLaunchRequest) -> RunAgentApiRequest {
    RunAgentApiRequest {
        user_id: request.user_id,
        submission_id: request.submission_id,
        thread_id: Some(request.thread_id),
        repository_key: None,
        prompt: request.prompt,
        storage_ids: Vec::new(),
        selected_model: request.selected_model,
        completion_provider: request.completion_provider,
        reasoning_effort: request.reasoning_effort,
        fast_mode: request.fast_mode,
        workspace_path: request.workspace_path,
        continuation_of_run_id: request.continuation_of_run_id,
        execution_secret: Some(request.execution_secret),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_request_reuses_the_committed_submission_and_secret() {
        let request = SubagentLaunchRequest {
            user_id: "user_1".into(),
            thread_id: "jd7child".into(),
            run_id: "jd7run".into(),
            submission_id: "subagent:jd7parent:job-1".into(),
            execution_secret: "child-secret".into(),
            prompt: "Continue with the selected answer".into(),
            workspace_path: "/workspace".into(),
            selected_model: "gpt-5.6-sol".into(),
            completion_provider: sprocket_agent::CompletionProvider::Spikonado,
            reasoning_effort: "high".into(),
            fast_mode: false,
            continuation_of_run_id: Some("jd7previouschildrun".into()),
        };
        let payload = launch_payload(request);
        assert_eq!(payload.submission_id, "subagent:jd7parent:job-1");
        assert_eq!(payload.execution_secret.as_deref(), Some("child-secret"));
        assert_eq!(payload.thread_id.as_deref(), Some("jd7child"));
        assert_eq!(payload.repository_key, None);
        assert_eq!(
            payload.continuation_of_run_id.as_deref(),
            Some("jd7previouschildrun")
        );
    }
}
