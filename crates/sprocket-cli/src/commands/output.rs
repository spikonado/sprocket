use std::collections::HashSet;
use std::io::Write;

use sprocket_server::cli_protocol::{CliResult, CliRunSnapshot, RunStarted};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum OutputFormat {
    Text,
    Json,
    StreamJson,
}

pub(super) struct Output {
    format: OutputFormat,
    started: Option<RunStarted>,
    after_part: i64,
    answer: String,
    tools: HashSet<String>,
    live: Option<serde_json::Value>,
    finished: bool,
    submission_id: Option<String>,
    termination_reason: Option<String>,
}

impl Output {
    pub fn new(format: OutputFormat) -> Self {
        Self {
            format,
            started: None,
            after_part: -1,
            answer: String::new(),
            tools: HashSet::new(),
            live: None,
            finished: false,
            submission_id: None,
            termination_reason: None,
        }
    }

    pub fn started(&self) -> Option<&RunStarted> {
        self.started.as_ref()
    }
    pub fn after_part(&self) -> i64 {
        self.after_part
    }

    pub fn submitting(&mut self, client_id: &str) {
        self.submission_id = Some(format!("cli:{client_id}"));
    }

    pub fn interrupted(&mut self, code: u8) {
        self.termination_reason = Some(if code == 124 { "timeout" } else { "signal" }.into());
    }

    pub fn start(&mut self, started: RunStarted) -> anyhow::Result<()> {
        if self.format == OutputFormat::StreamJson {
            json_line(
                &serde_json::json!({"type": "started", "runId": started.run_id, "threadId": started.thread_id}),
            )?;
        } else {
            eprintln!("Thread {} | Run {}", started.thread_id, started.run_id);
        }
        self.started = Some(started);
        Ok(())
    }

    pub fn update(&mut self, snapshot: &CliRunSnapshot) -> anyhow::Result<()> {
        let started = self
            .started
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("run has not started"))?;
        anyhow::ensure!(
            snapshot.run_id == started.run_id && snapshot.thread_id == started.thread_id,
            "server returned a different run"
        );
        for part in &snapshot.parts {
            if i64::from(part.number) <= self.after_part {
                continue;
            }
            anyhow::ensure!(
                part.run_id == snapshot.run_id,
                "transcript part belongs to another run"
            );
            if let Some(completion) = &part.completion {
                self.answer = completion
                    .items
                    .iter()
                    .filter(|item| {
                        item.get("type").and_then(|value| value.as_str()) == Some("text")
                    })
                    .filter_map(|item| item.get("text").and_then(|value| value.as_str()))
                    .collect::<Vec<_>>()
                    .join("");
                if completion.items.iter().any(|item| {
                    item.get("type").and_then(|value| value.as_str()) == Some("tool-call")
                }) {
                    self.answer.clear();
                }
                for item in &completion.items {
                    self.tool_progress(item);
                }
            }
            if part.tool.is_some() {
                self.answer.clear();
            }
            if self.format == OutputFormat::StreamJson {
                json_line(&serde_json::json!({"type": "transcript", "part": part}))?;
            }
            self.after_part = i64::from(part.number);
        }
        let live = snapshot
            .live
            .as_ref()
            .map(serde_json::to_value)
            .transpose()?;
        if live != self.live {
            if let Some(live) = &live {
                if let Some(parts) = live.get("parts").and_then(|parts| parts.as_array()) {
                    for part in parts {
                        self.tool_progress(part);
                    }
                }
            }
            if self.format == OutputFormat::StreamJson {
                json_line(&serde_json::json!({"type": "live", "live": live}))?;
            }
            self.live = live;
        }
        Ok(())
    }

    fn tool_progress(&mut self, item: &serde_json::Value) {
        if self.format == OutputFormat::StreamJson {
            return;
        }
        let Some(call_id) = item.get("callId").and_then(|id| id.as_str()) else {
            return;
        };
        let Some(name) = item.get("name").and_then(|name| name.as_str()) else {
            return;
        };
        if self.tools.insert(call_id.to_owned()) {
            eprintln!("{name}");
        }
    }

    pub fn finish(&mut self, status: String, error: Option<String>) -> anyhow::Result<()> {
        if self.finished {
            return Ok(());
        }
        let result = CliResult {
            submission_id: self.submission_id.clone(),
            termination_reason: self.termination_reason.clone(),
            run_id: self.started.as_ref().map(|started| started.run_id.clone()),
            thread_id: self
                .started
                .as_ref()
                .map(|started| started.thread_id.clone()),
            answer: if status == "completed" {
                self.answer.clone()
            } else {
                String::new()
            },
            status,
            error,
        };
        write_result(&mut std::io::stdout().lock(), self.format, &result)?;
        if self.format == OutputFormat::Text {
            if let Some(error) = &result.error {
                eprintln!("{error}");
            }
        }
        self.finished = true;
        Ok(())
    }

    pub fn failure(&mut self, error: String) -> anyhow::Result<()> {
        self.finish(
            if self.submission_id.is_some() {
                "unknown"
            } else {
                "failed"
            }
            .into(),
            Some(error),
        )
    }

    pub fn unknown(&mut self, error: String) -> anyhow::Result<()> {
        self.finish("unknown".into(), Some(error))
    }
}

fn json_line(value: &impl serde::Serialize) -> anyhow::Result<()> {
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, value)?;
    writeln!(stdout)?;
    stdout.flush()?;
    Ok(())
}

fn write_result(
    writer: &mut impl Write,
    format: OutputFormat,
    result: &CliResult,
) -> anyhow::Result<()> {
    match format {
        OutputFormat::Text => {
            if !result.answer.is_empty() {
                writeln!(writer, "{}", result.answer)?;
            }
        }
        OutputFormat::Json => {
            serde_json::to_writer(&mut *writer, result)?;
            writeln!(writer)?;
        }
        OutputFormat::StreamJson => {
            serde_json::to_writer(
                &mut *writer,
                &serde_json::json!({"type": "result", "result": result}),
            )?;
            writeln!(writer)?;
        }
    }
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(parts: serde_json::Value) -> CliRunSnapshot {
        serde_json::from_value(serde_json::json!({
            "runId": "run", "threadId": "thread", "status": "running",
            "error": null, "parts": parts, "hasMore": false, "executionFinished": false, "live": null,
        })).unwrap()
    }

    #[test]
    fn final_answer_excludes_tool_commentary_and_replayed_parts() {
        let mut output = Output::new(OutputFormat::Text);
        output.started = Some(RunStarted {
            run_id: "run".into(),
            thread_id: "thread".into(),
        });
        let commentary = snapshot(serde_json::json!([{
            "number": 1, "sourceKey": "one", "kind": "completion", "runId": "run",
            "completion": {"items": [{"type": "text", "text": "I'll inspect the files."}, {"type": "tool-call"}]}
        }]));
        output.update(&commentary).unwrap();
        assert!(output.answer.is_empty());
        output.update(&snapshot(serde_json::json!([{
            "number": 3, "sourceKey": "three", "kind": "completion", "runId": "run",
            "completion": {"items": [{"type": "reasoning", "text": "private"}, {"type": "text", "text": "Done."}]}
        }]))).unwrap();
        output.update(&commentary).unwrap();
        assert_eq!(output.answer, "Done.");
        assert_eq!(output.after_part(), 3);
        output
            .update(&snapshot(serde_json::json!([{
                "number": 4, "sourceKey": "four", "kind": "completion", "runId": "run",
                "completion": {"items": []}
            }])))
            .unwrap();
        assert!(output.answer.is_empty());
    }

    #[test]
    fn rejects_another_runs_transcript_without_advancing_cursor() {
        let mut output = Output::new(OutputFormat::Text);
        output.started = Some(RunStarted {
            run_id: "run".into(),
            thread_id: "thread".into(),
        });
        let page = snapshot(serde_json::json!([{
            "number": 1, "sourceKey": "one", "kind": "completion", "runId": "other",
            "completion": {"items": [{"type": "text", "text": "wrong answer"}]}
        }]));
        assert!(output.update(&page).is_err());
        assert_eq!(output.after_part(), -1);
    }

    #[test]
    fn json_result_is_one_line_even_when_answer_has_newlines() {
        let result = CliResult {
            submission_id: Some("cli:request".into()),
            termination_reason: None,
            run_id: Some("run".into()),
            thread_id: Some("thread".into()),
            status: "completed".into(),
            answer: "first\nsecond".into(),
            error: None,
        };
        let mut bytes = Vec::new();
        write_result(&mut bytes, OutputFormat::Json, &result).unwrap();
        assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 1);
        assert_eq!(
            serde_json::from_slice::<CliResult>(&bytes).unwrap().answer,
            result.answer
        );
    }
}
