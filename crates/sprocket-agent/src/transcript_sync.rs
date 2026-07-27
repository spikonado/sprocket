use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rig::agent::{AgentHook, Flow, StepEvent, StepEventKind};
use rig::completion::CompletionModel;
use sprocket_convex_provider::{COMPLETION_STREAM_SUPERSEDED, ConvexStreamSync};

/// Persists OpenAI (and other local Rig) streams into Convex beside the model call.
#[derive(Clone)]
pub(crate) struct TranscriptSyncHook {
    sync: ConvexStreamSync,
    tool_names: Arc<Mutex<HashMap<String, String>>>,
}

impl TranscriptSyncHook {
    pub(crate) fn new(sync: ConvexStreamSync) -> Self {
        Self {
            sync,
            tool_names: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(crate) fn sync(&self) -> &ConvexStreamSync {
        &self.sync
    }
}

impl<M> AgentHook<M> for TranscriptSyncHook
where
    M: CompletionModel,
{
    async fn on_event(&self, _context: &rig::agent::HookContext, event: StepEvent<'_, M>) -> Flow {
        let result = match event {
            StepEvent::CompletionCall { .. } => self.sync.begin_turn().await,
            StepEvent::TextDelta { delta, .. } => {
                let flush = self.sync.flush_due().await;
                if let Err(error) = flush {
                    return flow_from_sync_error(error);
                }
                // Convex merge appends text; send only the delta, never the aggregate.
                self.sync.push_text_delta(delta).await
            }
            StepEvent::ToolCallDelta {
                tool_call_id,
                tool_name,
                ..
            } => {
                if let Some(name) = tool_name
                    && let Ok(mut names) = self.tool_names.lock()
                {
                    names.insert(tool_call_id.to_owned(), name.to_owned());
                }
                Ok(())
            }
            StepEvent::ToolCall {
                tool_name,
                tool_call_id,
                args,
                ..
            } => {
                let call_id = tool_call_id
                    .map(str::to_owned)
                    .or_else(|| {
                        self.tool_names.lock().ok().and_then(|names| {
                            names
                                .iter()
                                .find(|(_, name)| *name == tool_name)
                                .map(|(id, _)| id.clone())
                        })
                    })
                    .unwrap_or_else(|| tool_name.to_owned());
                let input = serde_json::from_str(args)
                    .unwrap_or_else(|_| serde_json::json!({ "raw": args }));
                self.sync
                    .push_tool_call(&call_id, tool_name, input, None)
                    .await
            }
            // Reasoning deltas are mirrored from the live stream in provider.rs.
            // Finish only flushes pending text/tool batches.
            StepEvent::ModelTurnFinished { .. } => self.sync.finish_turn().await,
            StepEvent::StreamResponseFinish { .. } => self.sync.flush_due().await,
            _ => Ok(()),
        };

        match result {
            Ok(()) => Flow::cont(),
            Err(error) => flow_from_sync_error(error),
        }
    }

    fn observes(&self, kind: StepEventKind) -> bool {
        matches!(
            kind,
            StepEventKind::CompletionCall
                | StepEventKind::TextDelta
                | StepEventKind::ToolCallDelta
                | StepEventKind::ToolCall
                | StepEventKind::ModelTurnFinished
                | StepEventKind::StreamResponseFinish
        )
    }
}

fn flow_from_sync_error(error: anyhow::Error) -> Flow {
    let message = error.to_string();
    if message.contains(COMPLETION_STREAM_SUPERSEDED) {
        Flow::terminate(message)
    } else {
        Flow::terminate(format!("transcript sync failed: {message}"))
    }
}
