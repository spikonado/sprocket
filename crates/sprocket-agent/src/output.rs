use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use sprocket_transcript::{TranscriptPart, TranscriptStore};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RunOutcome {
    pub status: String,
    pub error: Option<String>,
}

#[derive(Default)]
struct State {
    numbers: BTreeSet<u32>,
    outcome: Option<RunOutcome>,
    finished: bool,
    error: Option<String>,
    output_error: Option<String>,
    answer: String,
    revision: u64,
}

struct Scope {
    store: Arc<TranscriptStore>,
    user_id: String,
    thread_id: String,
    run_id: String,
}

pub struct RunOutput {
    scope: OnceLock<Scope>,
    state: Mutex<State>,
    changed: watch::Sender<u64>,
}

pub struct RunOutputPage {
    pub revision: u64,
    pub parts: Vec<TranscriptPart>,
    pub has_more: bool,
    pub finished: bool,
    pub outcome: Option<RunOutcome>,
    pub answer: String,
    pub output_error: Option<String>,
}

impl Default for RunOutput {
    fn default() -> Self {
        Self {
            scope: OnceLock::new(),
            state: Mutex::new(State::default()),
            changed: watch::channel(0).0,
        }
    }
}

impl RunOutput {
    pub fn initialize(
        &self,
        store: Arc<TranscriptStore>,
        user_id: String,
        thread_id: String,
        run_id: String,
    ) {
        assert!(
            self.scope
                .set(Scope {
                    store,
                    user_id,
                    thread_id,
                    run_id
                })
                .is_ok(),
            "run output already initialized"
        );
    }

    fn update(&self, update: impl FnOnce(&mut State)) {
        let mut state = self.state.lock().unwrap();
        update(&mut state);
        state.revision += 1;
        self.changed.send_replace(state.revision);
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    pub(crate) async fn record_part(&self, part: TranscriptPart) {
        let Some(scope) = self.scope.get() else {
            return;
        };
        if part.run_id != scope.run_id {
            return;
        }
        let saved = scope
            .store
            .append_parts(
                &scope.user_id,
                &scope.thread_id,
                std::slice::from_ref(&part),
            )
            .await;
        self.update(|state| {
            if state.numbers.insert(part.number) {
                if let Some(completion) = &part.completion {
                    state.answer = completion
                        .items
                        .iter()
                        .filter(|item| item["type"] == "text")
                        .filter_map(|item| item["text"].as_str())
                        .collect();
                    if completion
                        .items
                        .iter()
                        .any(|item| item["type"] == "tool-call")
                    {
                        state.answer.clear();
                    }
                }
            }
            if let Err(error) = saved {
                state.output_error = Some(format!("Could not cache local run output: {error}"));
            }
        });
    }

    pub(crate) fn notify_live_update(&self) {
        self.update(|_| {});
    }

    pub(crate) fn empty_completion(&self) {
        self.update(|state| state.answer.clear());
    }

    pub(crate) fn finalized(&self, outcome: RunOutcome, accepted: bool) {
        self.update(|state| {
            if outcome.status == "completed" && !accepted && state.outcome.is_none() {
                state.answer.clear();
                state.output_error = Some("The run completed without accepting this executor's finalization. Its final answer could not be confirmed.".into());
            }
            state.outcome = Some(outcome);
        });
    }

    pub fn finish(&self, error: Option<String>) {
        self.update(|state| {
            state.finished = true;
            if state.outcome.is_none() && state.error.is_none() {
                state.error = Some(error.unwrap_or_else(|| "Execution stopped without a confirmed terminal result. Check the thread in Sprocket.".into()));
            }
        });
    }

    pub async fn page(&self, after_part: i64) -> anyhow::Result<RunOutputPage> {
        anyhow::ensure!(
            (-1..=i64::from(u32::MAX)).contains(&after_part),
            "invalid transcript cursor"
        );
        let scope = self.scope.get().context("run output has not started")?;
        let (numbers, mut page) = {
            let state = self.state.lock().unwrap();
            let lower = if after_part == -1 {
                std::ops::Bound::Included(0)
            } else {
                std::ops::Bound::Excluded(after_part as u32)
            };
            let numbers: Vec<_> = if state.output_error.is_none() {
                state
                    .numbers
                    .range((lower, std::ops::Bound::Unbounded))
                    .copied()
                    .take(17)
                    .collect()
            } else {
                Vec::new()
            };
            let outcome = if state.finished {
                Some(state.outcome.clone().unwrap_or(RunOutcome {
                    status: "unknown".into(),
                    error: state.error.clone(),
                }))
            } else {
                None
            };
            let answer = if outcome
                .as_ref()
                .is_some_and(|outcome| outcome.status == "completed")
            {
                state.answer.clone()
            } else {
                String::new()
            };
            let page = RunOutputPage {
                revision: state.revision,
                has_more: numbers.len() > 16,
                parts: Vec::new(),
                finished: state.finished,
                outcome,
                answer,
                output_error: state.output_error.clone(),
            };
            (numbers.into_iter().take(16).collect::<Vec<_>>(), page)
        };
        if page.output_error.is_some() || numbers.is_empty() {
            return Ok(page);
        }
        let parts = scope
            .store
            .read_parts(&scope.user_id, &scope.thread_id, &numbers)
            .await
            .and_then(|parts| {
                anyhow::ensure!(
                    parts.len() == numbers.len()
                        && parts.iter().all(|part| part.run_id == scope.run_id),
                    "local run transcript is missing or belongs to another run"
                );
                Ok(parts)
            });
        match parts {
            Ok(parts) => {
                page.parts = parts
                    .into_iter()
                    .map(TranscriptPart::without_work_assignment)
                    .collect();
            }
            Err(error) => {
                let error = format!("Could not read local run output: {error}");
                self.update(|state| state.output_error = Some(error.clone()));
                page.output_error = Some(error);
                page.has_more = false;
            }
        }
        Ok(page)
    }
}

#[cfg(test)]
mod tests;
