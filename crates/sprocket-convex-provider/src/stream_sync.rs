use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::Context;
use convex::Value;
use serde_json::json;
use tokio::sync::Mutex;
use tokio::time::{Instant, sleep};
use uuid::Uuid;

use crate::CompletionStreamEvent;
use crate::client::{COMPLETION_STREAM_SUPERSEDED, Client};

const STREAM_FLUSH_INTERVAL: Duration = Duration::from_millis(250);
const FLUSH_RETRY_DELAY: Duration = Duration::from_millis(100);
const MAX_PENDING_BEFORE_FLUSH: usize = 24;

#[derive(Clone)]
pub struct ConvexStreamSync {
    inner: Arc<StreamSyncInner>,
}

struct StreamSyncInner {
    client: Client,
    run_id: String,
    claim_id: String,
    state: Mutex<TurnState>,
    merged_any: AtomicBool,
}

#[derive(Default)]
struct TurnState {
    attempt_seq: u32,
    stream_id: String,
    next_batch_sequence: u64,
    pending: Vec<CompletionStreamEvent>,
    next_flush_at: Option<Instant>,
    text_part_id: Option<String>,
    reasoning_part_id: Option<String>,
    superseded_stream_ids: Vec<String>,
    active: bool,
}

impl ConvexStreamSync {
    pub fn new(client: Client, run_id: impl Into<String>, claim_id: impl Into<String>) -> Self {
        Self {
            inner: Arc::new(StreamSyncInner {
                client,
                run_id: run_id.into(),
                claim_id: claim_id.into(),
                state: Mutex::new(TurnState::default()),
                merged_any: AtomicBool::new(false),
            }),
        }
    }

    pub fn merged_any(&self) -> bool {
        self.inner.merged_any.load(Ordering::Relaxed)
    }

    pub async fn take_superseded_stream_ids(&self) -> Vec<String> {
        // Used when falling back to another provider after a failed pre-merge attempt.
        let mut state = self.inner.state.lock().await;
        std::mem::take(&mut state.superseded_stream_ids)
    }

    pub async fn seed_superseded_stream_ids(&self, stream_ids: impl IntoIterator<Item = String>) {
        let mut state = self.inner.state.lock().await;
        state.superseded_stream_ids.extend(stream_ids);
    }

    pub async fn begin_turn(&self) -> anyhow::Result<()> {
        let mut state = self.inner.state.lock().await;
        if state.active {
            self.flush_locked(&mut state).await?;
            if !state.stream_id.is_empty() {
                let prior_stream_id = state.stream_id.clone();
                state.superseded_stream_ids.push(prior_stream_id);
            }
        }

        let attempt_seq = self.inner.client.next_completion_attempt_seq();
        let stream_id = Uuid::new_v4().to_string();
        let superseded = state.superseded_stream_ids.clone();
        self.register_attempt(attempt_seq, &superseded).await?;

        // Sequence starts at 0 in completionStreamStates; first batch is 1.
        let initial_sequence = self.current_stream_sequence().await?;
        state.attempt_seq = attempt_seq;
        state.stream_id = stream_id;
        state.next_batch_sequence = initial_sequence + 1;
        state.pending.clear();
        state.next_flush_at = None;
        state.text_part_id = None;
        state.reasoning_part_id = None;
        state.active = true;
        Ok(())
    }

    pub async fn push_text_delta(&self, delta: &str) -> anyhow::Result<()> {
        if delta.is_empty() {
            return Ok(());
        }
        let mut state = self.inner.state.lock().await;
        if !state.active {
            return Ok(());
        }
        let stream_id = state.stream_id.clone();
        let part_id = state
            .text_part_id
            .get_or_insert_with(|| format!("{stream_id}:text:main"))
            .clone();
        let turn_id = stream_id;
        // Pending batch coalesces by replacing with concatenated text; Convex merge
        // appends each flushed batch, so only deltas may leave this process.
        append_text_delta(
            &mut state.pending,
            CompletionStreamEvent::Text {
                id: part_id,
                text: delta.to_owned(),
                turn_id: Some(turn_id),
                provider_metadata: None,
            },
        );
        self.maybe_schedule_flush(&mut state);
        self.maybe_flush_by_size(&mut state).await
    }

    pub async fn push_reasoning_delta(&self, id: Option<&str>, delta: &str) -> anyhow::Result<()> {
        if delta.is_empty() {
            return Ok(());
        }
        let mut state = self.inner.state.lock().await;
        if !state.active {
            return Ok(());
        }
        let stream_id = state.stream_id.clone();
        let part_id = match (&state.reasoning_part_id, id) {
            (Some(existing), _) => existing.clone(),
            (None, Some(provider_id)) => {
                let part_id = format!("{stream_id}:reasoning:{provider_id}");
                state.reasoning_part_id = Some(part_id.clone());
                part_id
            }
            (None, None) => {
                let part_id = format!("{stream_id}:reasoning:main");
                state.reasoning_part_id = Some(part_id.clone());
                part_id
            }
        };
        let turn_id = stream_id;
        let provider_metadata = id.map(|item_id| json!({ "openai": { "itemId": item_id } }));
        append_coalesced_event(
            &mut state.pending,
            CompletionStreamEvent::Reasoning {
                id: part_id,
                text: delta.to_owned(),
                turn_id: Some(turn_id),
                provider_reasoning_id: id.map(str::to_owned),
                provider_metadata,
            },
        );
        self.maybe_schedule_flush(&mut state);
        self.maybe_flush_by_size(&mut state).await
    }

    pub async fn push_tool_call(
        &self,
        call_id: &str,
        name: &str,
        input: serde_json::Value,
        provider_metadata: Option<serde_json::Value>,
    ) -> anyhow::Result<()> {
        let mut state = self.inner.state.lock().await;
        if !state.active {
            return Ok(());
        }
        let part_id = format!("{}:tool:{call_id}", state.stream_id);
        let turn_id = state.stream_id.clone();
        state.pending.push(CompletionStreamEvent::ToolCall {
            part_id,
            call_id: call_id.to_owned(),
            name: name.to_owned(),
            input,
            turn_id: Some(turn_id),
            provider_metadata,
        });
        self.flush_locked(&mut state).await
    }

    pub async fn finish_turn(&self) -> anyhow::Result<()> {
        let mut state = self.inner.state.lock().await;
        if !state.active {
            return Ok(());
        }
        self.flush_locked(&mut state).await?;
        state.active = false;
        state.text_part_id = None;
        state.reasoning_part_id = None;
        Ok(())
    }

    pub async fn abandon_turn_without_merge(&self) {
        let mut state = self.inner.state.lock().await;
        if state.active && !self.merged_any() && !state.stream_id.is_empty() {
            let prior_stream_id = state.stream_id.clone();
            state.superseded_stream_ids.push(prior_stream_id);
        }
        state.pending.clear();
        state.active = false;
        state.next_flush_at = None;
        state.text_part_id = None;
        state.reasoning_part_id = None;
    }

    pub async fn flush_due(&self) -> anyhow::Result<()> {
        let mut state = self.inner.state.lock().await;
        if !state.active {
            return Ok(());
        }
        let due = state
            .next_flush_at
            .is_some_and(|deadline| Instant::now() >= deadline);
        if due || state.pending.len() >= MAX_PENDING_BEFORE_FLUSH {
            self.flush_locked(&mut state).await?;
        }
        Ok(())
    }

    fn maybe_schedule_flush(&self, state: &mut TurnState) {
        if state.next_flush_at.is_none() && !state.pending.is_empty() {
            state.next_flush_at = Some(Instant::now() + STREAM_FLUSH_INTERVAL);
        }
    }

    async fn maybe_flush_by_size(&self, state: &mut TurnState) -> anyhow::Result<()> {
        if state.pending.len() >= MAX_PENDING_BEFORE_FLUSH {
            self.flush_locked(state).await?;
        }
        Ok(())
    }

    async fn flush_locked(&self, state: &mut TurnState) -> anyhow::Result<()> {
        if state.pending.is_empty() {
            state.next_flush_at = None;
            return Ok(());
        }
        let events = std::mem::take(&mut state.pending);
        let sequence = state.next_batch_sequence;
        let stream_id = state.stream_id.clone();
        let attempt_seq = state.attempt_seq;
        let mut last_error = None;
        for attempt in 0..2 {
            match self
                .merge_events(attempt_seq, &stream_id, sequence, &events)
                .await
            {
                Ok(outcome) => {
                    if outcome == "superseded" {
                        return Err(anyhow::anyhow!(COMPLETION_STREAM_SUPERSEDED));
                    }
                    self.inner.merged_any.store(true, Ordering::Relaxed);
                    state.next_batch_sequence += 1;
                    state.next_flush_at = None;
                    return Ok(());
                }
                Err(error) => {
                    if error.to_string().contains(COMPLETION_STREAM_SUPERSEDED) {
                        return Err(error);
                    }
                    last_error = Some(error);
                    if attempt == 0 {
                        sleep(FLUSH_RETRY_DELAY).await;
                    }
                }
            }
        }
        // Put events back so a later flush/finish can retry.
        state.pending = events;
        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("failed to flush stream events")))
    }

    async fn register_attempt(
        &self,
        attempt_seq: u32,
        superseded_stream_ids: &[String],
    ) -> anyhow::Result<()> {
        let mut args = BTreeMap::new();
        args.insert("runId".to_string(), self.inner.run_id.clone().into());
        args.insert("claimId".to_string(), self.inner.claim_id.clone().into());
        args.insert(
            "attemptSeq".to_string(),
            Value::Float64(f64::from(attempt_seq)),
        );
        if !superseded_stream_ids.is_empty() {
            args.insert(
                "supersededStreamIds".to_string(),
                Value::Array(
                    superseded_stream_ids
                        .iter()
                        .cloned()
                        .map(Value::from)
                        .collect(),
                ),
            );
        }
        if let Some(secret) = self.inner.client.execution_secret() {
            args.insert("executionSecret".to_string(), secret.to_string().into());
        }
        self.inner
            .client
            .mutation("agentRuntime:registerCompletionAttempt", args)
            .await
            .context("registerCompletionAttempt failed")?;
        Ok(())
    }

    async fn current_stream_sequence(&self) -> anyhow::Result<u64> {
        let mut args = BTreeMap::new();
        args.insert("runId".to_string(), self.inner.run_id.clone().into());
        if let Some(secret) = self.inner.client.execution_secret() {
            args.insert("executionSecret".to_string(), secret.to_string().into());
        }
        let result = self
            .inner
            .client
            .query("agentRuntime:completionActor", args)
            .await
            .context("completionActor query failed")?;
        let value = match result {
            convex::FunctionResult::Value(value) => value,
            convex::FunctionResult::ErrorMessage(message) => anyhow::bail!(message),
            convex::FunctionResult::ConvexError(error) => anyhow::bail!(error.message),
        };
        let json: serde_json::Value = value.into();
        let sequence = json
            .get("streamSequence")
            .and_then(|value| value.as_f64())
            .context("missing streamSequence")?;
        Ok(sequence as u64)
    }

    async fn merge_events(
        &self,
        attempt_seq: u32,
        stream_id: &str,
        sequence: u64,
        events: &[CompletionStreamEvent],
    ) -> anyhow::Result<String> {
        let mut args = BTreeMap::new();
        args.insert("runId".to_string(), self.inner.run_id.clone().into());
        args.insert("claimId".to_string(), self.inner.claim_id.clone().into());
        args.insert(
            "attemptSeq".to_string(),
            Value::Float64(f64::from(attempt_seq)),
        );
        args.insert("streamId".to_string(), stream_id.to_string().into());
        args.insert("sequence".to_string(), Value::Float64(sequence as f64));
        let events_json = serde_json::to_value(events).context("serialize stream events")?;
        args.insert(
            "events".to_string(),
            Value::try_from(events_json).context("convert stream events")?,
        );
        if let Some(secret) = self.inner.client.execution_secret() {
            args.insert("executionSecret".to_string(), secret.to_string().into());
        }
        let result = self
            .inner
            .client
            .mutation("agentRuntime:mergeAssistantStreamEvents", args)
            .await
            .context("mergeAssistantStreamEvents failed")?;
        match result {
            convex::FunctionResult::Value(Value::String(outcome)) => Ok(outcome),
            convex::FunctionResult::Value(other) => {
                let json: serde_json::Value = other.into();
                Ok(json.as_str().unwrap_or("merged").to_string())
            }
            convex::FunctionResult::ErrorMessage(message) => Err(anyhow::anyhow!(message)),
            convex::FunctionResult::ConvexError(error) => Err(anyhow::anyhow!(error.message)),
        }
    }
}

fn append_text_delta(events: &mut Vec<CompletionStreamEvent>, event: CompletionStreamEvent) {
    if let (
        Some(CompletionStreamEvent::Text {
            id: prev_id,
            text: prev_text,
            turn_id: prev_turn,
            provider_metadata: prev_meta,
        }),
        CompletionStreamEvent::Text {
            id,
            text,
            turn_id,
            provider_metadata,
        },
    ) = (events.last_mut(), &event)
        && prev_id == id
    {
        prev_text.push_str(text);
        if turn_id.is_some() {
            *prev_turn = turn_id.clone();
        }
        if provider_metadata.is_some() {
            *prev_meta = provider_metadata.clone();
        }
        return;
    }
    events.push(event);
}

fn append_coalesced_event(events: &mut Vec<CompletionStreamEvent>, event: CompletionStreamEvent) {
    if let (
        Some(CompletionStreamEvent::Reasoning {
            id: prev_id,
            text: prev_text,
            turn_id: prev_turn,
            provider_reasoning_id: prev_reasoning_id,
            provider_metadata: prev_meta,
        }),
        CompletionStreamEvent::Reasoning {
            id,
            text,
            turn_id,
            provider_reasoning_id,
            provider_metadata,
        },
    ) = (events.last_mut(), &event)
        && prev_id == id
    {
        prev_text.push_str(text);
        if turn_id.is_some() {
            *prev_turn = turn_id.clone();
        }
        if provider_reasoning_id.is_some() {
            *prev_reasoning_id = provider_reasoning_id.clone();
        }
        if provider_metadata.is_some() {
            *prev_meta = provider_metadata.clone();
        }
        return;
    }
    events.push(event);
}
