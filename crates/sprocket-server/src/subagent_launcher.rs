use std::sync::Arc;

use sprocket_agent::subagents::{SharedSubagentLauncher, SubagentLaunchRequest, SubagentLauncher};

use crate::AppState;
use crate::agent_launch::{RunAgentApiRequest, WorkspaceAccess, launch_agent};

struct NativeSubagentLauncher {
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
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + Send + '_>> {
        Box::pin(async move {
            let payload = RunAgentApiRequest {
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
            };
            launch_agent(
                self.state.clone(),
                payload,
                WorkspaceAccess::RunDirectory,
                true,
                sprocket_workspace::WorkspaceCancellation::new(),
                None,
            )
            .await
            .map_err(|error| anyhow::anyhow!("failed to launch subagent: {error}"))?;
            Ok(())
        })
    }
}
