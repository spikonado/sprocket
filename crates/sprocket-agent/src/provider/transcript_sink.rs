use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rig::message::AssistantContent;
use sprocket_transcript::{
    LiveAssistantPart, LiveAssistantParts, LiveCompletionHub, LiveCompletionOverlay,
    join_assistant_text_parts,
};

use crate::convex::RuntimeClient;
use crate::hooks::ToolCallTracker;
use crate::now_ms;
use crate::reasoning::{apply_completed_reasoning, merge_provider_metadata};
use crate::usage::ModelCallUsage;

const TRANSCRIPT_FLUSH_INTERVAL: Duration = Duration::from_millis(500);

pub(super) struct TranscriptSink {
    runtime: RuntimeClient,
    live: Arc<LiveCompletionHub>,
    run_id: String,
    claim_id: String,
    thread_id: String,
    stream_id: String,
    attempt_seq: u64,
    parts: LiveAssistantParts,
    provider_metadata: HashMap<String, serde_json::Value>,
    last_publish: Instant,
    unpublished: usize,
    streamed: bool,
    finalized: bool,
    usage_tokens: Option<u64>,
    call_usage: Option<ModelCallUsage>,
    tool_call_tracker: ToolCallTracker,
}

impl TranscriptSink {
    pub(super) async fn start(
        runtime: RuntimeClient,
        live: Arc<LiveCompletionHub>,
        run_id: String,
        claim_id: String,
        thread_id: String,
        tool_call_tracker: ToolCallTracker,
    ) -> anyhow::Result<Self> {
        runtime
            .register_completion_attempt(&run_id, &claim_id, 1)
            .await?;
        Ok(Self {
            stream_id: format!("agent:{run_id}:{claim_id}:1"),
            runtime,
            live,
            run_id,
            claim_id,
            thread_id,
            attempt_seq: 1,
            parts: LiveAssistantParts::default(),
            provider_metadata: HashMap::new(),
            last_publish: Instant::now(),
            unpublished: 0,
            streamed: false,
            finalized: false,
            usage_tokens: None,
            call_usage: None,
            tool_call_tracker,
        })
    }

    pub(super) fn attempt_seq(&self) -> u64 {
        self.attempt_seq
    }

    pub(super) fn assistant_text(&self) -> String {
        join_assistant_text_parts(&self.parts.parts)
    }

    pub(super) fn push_streamed_text(&mut self, part: usize, text: &str) {
        let id = format!("{}:text:{part}", self.stream_id);
        let turn_id = Some(self.stream_id.clone());
        self.apply_text_delta("text", id, text, turn_id);
        self.publish_if_needed(false);
    }

    pub(super) fn complete_text(&mut self, part: usize, text: &rig::message::Text) {
        self.streamed = true;
        self.unpublished += 1;
        apply_completed_text(
            &mut self.parts,
            &mut self.provider_metadata,
            &self.stream_id,
            part,
            text,
        );
        self.publish_if_needed(true);
    }

    pub(super) fn push_reasoning(&mut self, part: usize, text: &str) {
        let part_id = format!("{}:reasoning:{part}", self.stream_id);
        let turn_id = Some(self.stream_id.clone());
        self.apply_text_delta("reasoning", part_id, text, turn_id);
        self.publish_if_needed(false);
    }

    pub(super) fn complete_reasoning(&mut self, part: usize, reasoning: &rig::message::Reasoning) {
        self.streamed = true;
        self.unpublished += 1;
        apply_completed_reasoning(
            &mut self.parts,
            &mut self.provider_metadata,
            &self.stream_id,
            &format!("reasoning:{part}"),
            reasoning,
        );
        self.publish_if_needed(true);
    }

    pub(super) fn push_tool_call(&mut self, part: usize, call: rig::message::ToolCall) {
        self.streamed = true;
        self.unpublished += 1;
        apply_completed_tool_call(
            &mut self.parts,
            &mut self.provider_metadata,
            &self.stream_id,
            Some(format!("{}:tool:{part}", self.stream_id)),
            call,
        );
        self.publish_if_needed(true);
    }

    fn reset_parts(&mut self) {
        self.parts.clear();
        self.provider_metadata.clear();
        self.unpublished = 0;
        self.streamed = false;
        self.finalized = false;
        self.usage_tokens = None;
        self.call_usage = None;
    }

    pub(super) async fn finalize_turn(&mut self) -> anyhow::Result<()> {
        self.publish_if_needed(true);
        self.runtime
            .finalize_completion_call(
                &self.run_id,
                &self.claim_id,
                self.attempt_seq,
                &self.stream_id,
                self.items_json(),
                self.tool_call_tracker.completion_assignments(),
                self.usage_tokens,
                self.call_usage.as_ref(),
            )
            .await?;
        self.streamed = false;
        self.finalized = true;
        Ok(())
    }

    pub(super) async fn advance_attempt(&mut self) -> anyhow::Result<()> {
        self.reset_parts();
        self.attempt_seq += 1;
        self.stream_id = format!(
            "agent:{}:{}:{}",
            self.run_id, self.claim_id, self.attempt_seq
        );
        self.runtime
            .register_completion_attempt(&self.run_id, &self.claim_id, self.attempt_seq)
            .await?;
        self.tool_call_tracker
            .begin_attempt(self.attempt_seq, &self.stream_id);
        Ok(())
    }

    pub(super) async fn finalize_turn_if_streamed(&mut self) -> anyhow::Result<()> {
        if self.streamed {
            self.finalize_turn().await?;
        }
        Ok(())
    }

    pub(super) async fn begin_next_turn_after_tools(&mut self) -> anyhow::Result<()> {
        self.finalize_turn_if_streamed().await?;
        if self.finalized {
            self.advance_attempt().await?;
        }
        Ok(())
    }

    fn items_json(&self) -> Vec<serde_json::Value> {
        durable_items_json(&self.parts.parts, &self.provider_metadata)
    }

    pub(super) fn has_unpublished(&self) -> bool {
        self.unpublished > 0
    }

    pub(super) fn record_usage(&mut self, tokens: Option<u64>, call_usage: Option<ModelCallUsage>) {
        if tokens.is_some() {
            self.usage_tokens = tokens;
        }
        if call_usage.is_some() {
            self.call_usage = call_usage;
        }
    }

    pub(super) fn record_stream_parts(&mut self) {
        self.parts.order_stream_parts(&self.stream_id);
        self.tool_call_tracker.record_parts(&self.parts.parts);
    }

    pub(super) fn record_origin(&mut self, origin: &rig::message::Origin) {
        apply_completion_origin(&self.parts.parts, &mut self.provider_metadata, origin);
    }

    pub(super) fn publish_delay(&self) -> Duration {
        TRANSCRIPT_FLUSH_INTERVAL.saturating_sub(self.last_publish.elapsed())
    }

    pub(super) fn publish_if_needed(&mut self, force: bool) {
        if self.unpublished == 0 {
            return;
        }
        if !force
            && self.unpublished < 24
            && self.last_publish.elapsed() < TRANSCRIPT_FLUSH_INTERVAL
        {
            return;
        }
        self.publish();
    }

    fn publish(&mut self) {
        self.unpublished = 0;
        self.last_publish = Instant::now();
        let overlay = LiveCompletionOverlay {
            thread_id: self.thread_id.clone(),
            run_id: self.run_id.clone(),
            run_status: "running".to_string(),
            stream_id: self.stream_id.clone(),
            text: self.assistant_text(),
            parts: visible_live_parts(&self.parts.parts),
        };
        self.live.publish(overlay);
        if let Some(output) = &self.runtime.output {
            output.notify_live_update();
        }
    }

    pub(super) fn clear_live(&self) {
        self.live.clear(&self.thread_id);
        if let Some(output) = &self.runtime.output {
            output.notify_live_update();
        }
    }

    fn apply_text_delta(
        &mut self,
        event_type: &str,
        id: String,
        delta: &str,
        turn_id: Option<String>,
    ) {
        self.streamed = true;
        self.unpublished += 1;
        self.parts
            .apply_text_delta(event_type, id, delta, turn_id, now_ms());
    }
}

impl Drop for TranscriptSink {
    fn drop(&mut self) {
        self.publish_if_needed(true);
        self.clear_live();
    }
}

fn part_metadata_key(part: &LiveAssistantPart) -> String {
    match part {
        LiveAssistantPart::Text { id, .. } => format!("text:{id}"),
        LiveAssistantPart::Reasoning { id, .. } => format!("reasoning:{id}"),
        LiveAssistantPart::ToolCall {
            part_id, call_id, ..
        } => part_id.clone().unwrap_or_else(|| call_id.clone()),
    }
}

pub(super) fn visible_live_parts(parts: &[LiveAssistantPart]) -> Vec<LiveAssistantPart> {
    parts
        .iter()
        .filter(|part| {
            !matches!(part, LiveAssistantPart::Reasoning { text, .. } if text.trim().is_empty())
        })
        .cloned()
        .collect()
}

pub(super) fn durable_items_json(
    parts: &[LiveAssistantPart],
    provider_metadata: &HashMap<String, serde_json::Value>,
) -> Vec<serde_json::Value> {
    parts
        .iter()
        .map(|part| merge_provider_metadata(part, provider_metadata.get(&part_metadata_key(part))))
        .collect()
}

pub(super) fn apply_completion_origin(
    parts: &[LiveAssistantPart],
    provider_metadata: &mut HashMap<String, serde_json::Value>,
    origin: &rig::message::Origin,
) {
    for part in parts {
        let metadata = provider_metadata
            .entry(part_metadata_key(part))
            .or_insert_with(|| serde_json::json!({}));
        metadata["origin"] = serde_json::to_value(origin).expect("origin always serializes");
    }
}

pub(super) fn apply_completed_text(
    parts: &mut LiveAssistantParts,
    provider_metadata: &mut HashMap<String, serde_json::Value>,
    stream_id: &str,
    part: usize,
    completed: &rig::message::Text,
) -> String {
    let id = format!("{stream_id}:text:{part}");
    let previous = parts.apply_completed_text(
        id.clone(),
        completed.text.clone(),
        Some(stream_id.to_string()),
        now_ms(),
    );
    let block = AssistantContent::Text(completed.clone());
    if let Some(native) = block.native_item() {
        let mut item = native.clone();
        if let Some(content) = item
            .get_mut("content")
            .and_then(serde_json::Value::as_array_mut)
        {
            for part in content {
                if let Some(part) = part.as_object_mut() {
                    part.remove("text");
                }
            }
        }
        provider_metadata.insert(
            format!("text:{id}"),
            serde_json::json!({ "rigNative": item }),
        );
    }
    previous
}

pub(super) fn apply_completed_tool_call(
    parts: &mut LiveAssistantParts,
    provider_metadata: &mut HashMap<String, serde_json::Value>,
    stream_id: &str,
    part_id: Option<String>,
    call: rig::message::ToolCall,
) {
    let call_id = call.id.wire().into_owned();
    let key = part_id.clone().unwrap_or_else(|| call_id.clone());
    let block = AssistantContent::ToolCall(call.clone());
    if let Some(native) = block.native_item() {
        let mut item = native.clone();
        // Replay rebuilds canonical arguments, so only keep the model's
        // spelling when it differs; replaying other bytes breaks prompt caching.
        let canonical = call.function.arguments_value().to_string();
        if let Some(item) = item.as_object_mut()
            && item.get("arguments").and_then(serde_json::Value::as_str) == Some(&canonical)
        {
            item.remove("arguments");
        }
        provider_metadata.insert(key, serde_json::json!({ "rigNative": item }));
    } else {
        provider_metadata.remove(&key);
    }
    parts.apply_tool_call(
        part_id,
        call_id,
        call.function.name.into(),
        call.function.arguments.into(),
        Some(stream_id.to_string()),
        now_ms(),
    );
}
