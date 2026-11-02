use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use sprocket_agent::CompletionProvider;
use sprocket_agent::subagents::{SharedSubagentLauncher, SubagentLaunchRequest, SubagentLauncher};

use crate::Host;
use crate::agent_launch::{AgentLaunchRequest, WorkspaceAccess, launch_agent};

struct NativeSubagentLauncher {
    host: Host,
}

pub fn launcher(host: &Host) -> SharedSubagentLauncher {
    Arc::new(NativeSubagentLauncher { host: host.clone() })
}

impl SubagentLauncher for NativeSubagentLauncher {
    fn launch(
        &self,
        request: SubagentLaunchRequest,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + '_>> {
        Box::pin(async move {
            let payload = AgentLaunchRequest {
                user_id: request.user_id,
                submission_id: request.submission_id,
                thread_id: Some(request.thread_id),
                repository_key: None,
                // The child run already holds its prompt.
                prompt: String::new(),
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
                self.host.clone(),
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

    fn usable_providers(
        &self,
        user_id: String,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<Vec<CompletionProvider>>> + Send + '_>> {
        Box::pin(async move {
            let rpc = self.host.convex_client_for(&user_id).await?;
            crate::providers::usable_providers(&self.host, &rpc, &user_id).await
        })
    }
}
