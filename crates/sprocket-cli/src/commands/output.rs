use std::collections::HashSet;
use std::io::Write;

use sprocket_server::cli_protocol::{CliRunSnapshot, RunStarted};

fn run_header(started: &RunStarted) -> String {
    format!(
        "Thread {} | Run {}\nModel {} | Reasoning {} | Fast {}",
        started.thread_id,
        started.run_id,
        started.settings.model,
        started.settings.reasoning,
        if started.settings.fast { "on" } else { "off" }
    )
}

pub(super) struct Output {
    started: Option<RunStarted>,
    after_part: i64,
    after_revision: Option<u64>,
    answer: String,
    tools: HashSet<String>,
    live: Option<serde_json::Value>,
    finished: bool,
}

impl Output {
    pub fn new() -> Self {
        Self {
            started: None,
            after_part: -1,
            after_revision: None,
            answer: String::new(),
            tools: HashSet::new(),
            live: None,
            finished: false,
        }
    }

    pub fn started(&self) -> Option<&RunStarted> {
        self.started.as_ref()
    }
    pub fn after_part(&self) -> i64 {
        self.after_part
    }

    pub fn after_revision(&self) -> Option<u64> {
        self.after_revision
    }

    pub fn start(&mut self, started: RunStarted) -> anyhow::Result<()> {
        eprintln!("{}", run_header(&started));
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
                for item in &completion.items {
                    self.tool_progress(item);
                }
            }
            self.after_part = i64::from(part.number);
        }
        self.after_revision = (!snapshot.has_more).then_some(snapshot.revision);
        self.answer = snapshot.answer.clone();
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
            self.live = live;
        }
        Ok(())
    }

    fn tool_progress(&mut self, item: &serde_json::Value) {
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
        if status == "completed" && !self.answer.is_empty() {
            let mut stdout = std::io::stdout().lock();
            writeln!(stdout, "{}", self.answer)?;
            stdout.flush()?;
        }
        if let Some(error) = error {
            eprintln!("{error}");
        }
        self.finished = true;
        Ok(())
    }

    pub fn failure(&mut self, error: String) -> anyhow::Result<()> {
        self.finish("failed".into(), Some(error))
    }

    pub fn unknown(&mut self, error: String) -> anyhow::Result<()> {
        self.finish("unknown".into(), Some(error))
    }
}

#[cfg(test)]
mod tests;
