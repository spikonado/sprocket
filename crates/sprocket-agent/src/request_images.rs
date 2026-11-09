use std::sync::Arc;

use rig::agent::{
    AgentHook, CompletionCallAction, CompletionCallEvent, HookContext, RequestPatch, StepEventKind,
};
use rig::completion::Message;
use rig::message::{ToolResultContent, UserContent};

/// Gateways inline image URLs as base64, and Bedrock rejects requests over
/// 32 MiB with "Input is too long.", so this cap times `MAX_MODEL_IMAGE_BYTES`
/// must leave room for the text.
const MAX_REQUEST_IMAGES: usize = 20;
/// Omitting in batches changes the request prefix once per batch instead of
/// on every new image, which keeps the prompt cache warm.
const OMIT_BATCH: usize = 10;
const OMITTED_IMAGE: &str = "[This older image was left out of the request to stay within the provider's size limit. Read the file again if you need it.]";

#[derive(Clone, Copy)]
pub(crate) struct RequestImageLimit;

fn images_to_omit(total: usize) -> usize {
    if total <= MAX_REQUEST_IMAGES {
        return 0;
    }
    (total - (MAX_REQUEST_IMAGES - OMIT_BATCH)) / OMIT_BATCH * OMIT_BATCH
}

fn image_count(message: &Message) -> usize {
    let Message::User { content } = message else {
        return 0;
    };
    content
        .iter()
        .map(|item| match item {
            UserContent::Image(_) => 1,
            UserContent::ToolResult(result) => result
                .content
                .iter()
                .filter(|part| matches!(part, ToolResultContent::Image(_)))
                .count(),
            _ => 0,
        })
        .sum()
}

fn omit_oldest_images(history: &[Arc<Message>], mut count: usize) -> Vec<Arc<Message>> {
    history
        .iter()
        .map(|message| {
            if count == 0 || image_count(message) == 0 {
                return message.clone();
            }
            let mut message = (**message).clone();
            if let Message::User { content } = &mut message {
                for item in content {
                    match item {
                        UserContent::Image(_) if count > 0 => {
                            *item = UserContent::text(OMITTED_IMAGE);
                            count -= 1;
                        }
                        UserContent::ToolResult(result) => {
                            for part in &mut result.content {
                                if count > 0 && matches!(part, ToolResultContent::Image(_)) {
                                    *part = ToolResultContent::text(OMITTED_IMAGE);
                                    count -= 1;
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            Arc::new(message)
        })
        .collect()
}

impl AgentHook for RequestImageLimit {
    fn observes(&self, kind: StepEventKind) -> bool {
        kind == StepEventKind::CompletionCall
    }

    async fn on_completion_call(
        &self,
        _context: &HookContext,
        event: CompletionCallEvent<'_>,
    ) -> CompletionCallAction {
        let total = event
            .history
            .iter()
            .map(|message| image_count(message))
            .sum::<usize>()
            + image_count(event.prompt);
        match images_to_omit(total) {
            0 => CompletionCallAction::Continue,
            count => CompletionCallAction::patch(
                RequestPatch::new().history(omit_oldest_images(event.history, count)),
            ),
        }
    }
}

#[cfg(test)]
mod tests;
