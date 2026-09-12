use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::{TranscriptPart, TranscriptStore};

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
        self.update(|state| match saved {
            Ok(_) => {
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
            }
            Err(error) => state.error = Some(format!("Could not cache local run output: {error}")),
        });
    }

    pub(crate) fn notify_live_update(&self) {
        self.update(|_| {});
    }

    pub(crate) fn empty_completion(&self) {
        self.update(|state| state.answer.clear());
    }

    pub(crate) fn finalized(&self, outcome: RunOutcome, accepted: bool) {
        if outcome.status == "completed" && !accepted {
            return;
        }
        self.update(|state| state.outcome = Some(outcome));
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
            let numbers: Vec<_> = state
                .numbers
                .range((lower, std::ops::Bound::Unbounded))
                .copied()
                .take(17)
                .collect();
            let outcome = if state.finished {
                Some(if let Some(error) = &state.error {
                    RunOutcome {
                        status: "unknown".into(),
                        error: Some(error.clone()),
                    }
                } else {
                    state.outcome.clone().unwrap_or(RunOutcome {
                        status: "unknown".into(),
                        error: None,
                    })
                })
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
            };
            (numbers.into_iter().take(16).collect::<Vec<_>>(), page)
        };
        page.parts = scope
            .store
            .read_parts(&scope.user_id, &scope.thread_id, &numbers)
            .await?;
        anyhow::ensure!(
            page.parts.len() == numbers.len()
                && page.parts.iter().all(|part| part.run_id == scope.run_id),
            "local run transcript is missing or belongs to another run"
        );
        Ok(page)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::types::{TranscriptCompletionBody, TranscriptPartKind};

    fn completion(number: u32, text: &str) -> TranscriptPart {
        TranscriptPart {
            number,
            source_key: format!("completion:run:{number}"),
            kind: TranscriptPartKind::Completion,
            run_id: "run".into(),
            created_at: None,
            prompt: None,
            tool: None,
            completion: Some(TranscriptCompletionBody {
                stream_id: None,
                items: vec![serde_json::json!({"type": "text", "text": text})],
            }),
        }
    }

    fn output(directory: &std::path::Path) -> RunOutput {
        let output = RunOutput::default();
        output.initialize(
            TranscriptStore::new(directory.to_owned()),
            "user".into(),
            "thread".into(),
            "run".into(),
        );
        output
    }

    #[tokio::test]
    async fn caches_committed_parts_and_replays_bounded_pages_without_network_reads() {
        let directory = tempfile::tempdir().unwrap();
        let output = output(directory.path());
        for number in 0..18 {
            output
                .record_part(completion(number * 2, &format!("answer {number}")))
                .await;
        }
        output
            .record_part(completion(0, "duplicate must not replace answer"))
            .await;
        let first = output.page(-1).await.unwrap();
        assert_eq!(first.parts.len(), 16);
        assert!(first.has_more);
        assert_eq!(first.parts[0].number, 0);
        assert_eq!(first.parts[15].number, 30);
        assert!(first.answer.is_empty());
        let replay = output.page(-1).await.unwrap();
        assert_eq!(first.parts, replay.parts);
        output.finalized(
            RunOutcome {
                status: "completed".into(),
                error: None,
            },
            true,
        );
        assert!(!output.page(30).await.unwrap().finished);
        output.finish(None);
        let last = output.page(30).await.unwrap();
        assert_eq!(last.parts.len(), 2);
        assert!(!last.has_more);
        assert!(last.finished);
        assert_eq!(last.answer, "answer 17");
        assert!(output.page(-2).await.is_err());
    }

    #[tokio::test]
    async fn clearing_live_output_does_not_complete_a_run_and_unconfirmed_exit_is_unknown() {
        let directory = tempfile::tempdir().unwrap();
        let output = output(directory.path());
        let mut changed = output.subscribe();
        output.notify_live_update();
        changed.changed().await.unwrap();
        assert!(!output.page(-1).await.unwrap().finished);
        output
            .record_part(completion(1, "unconfirmed answer"))
            .await;
        output.finish(Some("finalization timed out".into()));
        let page = output.page(-1).await.unwrap();
        assert!(page.finished);
        assert_eq!(page.outcome.unwrap().status, "unknown");
        assert!(page.answer.is_empty());
    }

    #[tokio::test]
    async fn cancelled_and_empty_completions_do_not_return_earlier_commentary() {
        let directory = tempfile::tempdir().unwrap();
        let output = output(directory.path());
        output.record_part(completion(1, "earlier answer")).await;
        output.empty_completion();
        output.finalized(
            RunOutcome {
                status: "completed".into(),
                error: None,
            },
            true,
        );
        output.finish(None);
        assert!(output.page(-1).await.unwrap().answer.is_empty());

        let directory = tempfile::tempdir().unwrap();
        let cancelled = self::output(directory.path());
        cancelled
            .record_part(completion(1, "answer before cancellation race"))
            .await;
        cancelled.finalized(
            RunOutcome {
                status: "cancelled".into(),
                error: None,
            },
            false,
        );
        cancelled.finish(None);
        let page = cancelled.page(-1).await.unwrap();
        assert!(page.answer.is_empty());
        assert_eq!(page.outcome.unwrap().status, "cancelled");
    }

    #[tokio::test]
    async fn tool_commentary_and_other_runs_cannot_become_the_final_answer() {
        let directory = tempfile::tempdir().unwrap();
        let output = output(directory.path());
        let mut part = completion(2, "I'll run the tests.");
        part.completion.as_mut().unwrap().items.push(serde_json::json!({"type": "tool-call", "callId": "call", "name": "exec_command", "input": {}}));
        output.record_part(part).await;
        let mut other = completion(3, "another run's answer");
        other.run_id = "other".into();
        output.record_part(other).await;
        output.finalized(
            RunOutcome {
                status: "completed".into(),
                error: None,
            },
            true,
        );
        output.finish(None);
        let page = output.page(-1).await.unwrap();
        assert_eq!(page.parts.len(), 1);
        assert!(page.answer.is_empty());
    }

    #[tokio::test]
    async fn another_executors_completion_cannot_confirm_the_local_answer() {
        let directory = tempfile::tempdir().unwrap();
        let output = output(directory.path());
        output
            .record_part(completion(1, "stale local answer"))
            .await;
        output.finalized(
            RunOutcome {
                status: "completed".into(),
                error: None,
            },
            false,
        );
        output.finish(Some("claim ownership was lost".into()));
        let page = output.page(-1).await.unwrap();
        assert_eq!(page.outcome.unwrap().status, "unknown");
        assert!(page.answer.is_empty());
    }
}
