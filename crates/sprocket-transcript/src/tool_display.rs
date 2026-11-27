use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

const ROW_SUMMARY_CHARS: usize = 300;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl ToolStatus {
    pub fn from_result(status: Option<&str>) -> Self {
        match status {
            None => Self::Running,
            Some("failed") => Self::Failed,
            Some("cancelled") => Self::Cancelled,
            Some(_) => Self::Completed,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToolDisplayAction {
    OpenFile { path: String },
    OpenUrl { url: String },
    SaveCard,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CommandHighlight {
    pub start: usize,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDisplay {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub summary: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<CommandHighlight>,
    pub status: ToolStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<ToolDisplayAction>,
}

impl ToolDisplay {
    /// List rows drop the commands, so command rows always load details to highlight them.
    pub fn shorten(&mut self) -> bool {
        let dropped_command = !std::mem::take(&mut self.commands).is_empty();
        let preview: String = self
            .summary
            .split(['\r', '\n'])
            .next()
            .unwrap_or_default()
            .chars()
            .take(ROW_SUMMARY_CHARS)
            .collect();
        let has_more = dropped_command || preview != self.summary;
        self.summary = preview;
        has_more
    }
}

pub struct ToolDisplayInput<'a> {
    name: &'a str,
    input: &'a Value,
    output: Option<&'a Value>,
    status: ToolStatus,
}

pub(crate) fn polled_targets<'a>(
    name: &'a str,
    input: &'a Value,
    output: Option<&'a Value>,
    status: ToolStatus,
) -> Option<Vec<ToolDisplayInput<'a>>> {
    let key = match name {
        "poll_cmd" => "sessionIds",
        "poll_subagent" => "threads",
        "poll_pr" => "pullRequests",
        _ => return None,
    };
    if let Some(results) = output.and_then(Value::as_array) {
        return Some(
            results
                .iter()
                .map(|result| {
                    let status =
                        if string(result, "error").is_some() && result.get("command").is_none() {
                            ToolStatus::Failed
                        } else {
                            status
                        };
                    ToolDisplayInput::new(name, result, Some(result), status)
                })
                .collect(),
        );
    }
    Some(
        input
            .get(key)?
            .as_array()?
            .iter()
            .map(|target| ToolDisplayInput::new(name, target, None, status))
            .collect(),
    )
}

impl<'a> ToolDisplayInput<'a> {
    pub fn new(
        name: &'a str,
        input: &'a Value,
        output: Option<&'a Value>,
        status: ToolStatus,
    ) -> Self {
        Self {
            name,
            input,
            output,
            status,
        }
    }

    pub fn session_id(&self) -> Option<&str> {
        self.output
            .and_then(|output| string(output, "sessionId"))
            .or_else(|| string(self.input, "sessionId"))
            .or_else(|| {
                (self.name == "poll_cmd")
                    .then(|| self.input.as_str())
                    .flatten()
            })
    }

    pub fn display(&self, session_command: Option<&str>) -> ToolDisplay {
        let command = match self.name {
            "exec_cmd" | "exec_command" => string(self.input, "cmd"),
            name if is_session_command(name) => {
                session_command.or_else(|| self.output.and_then(|output| string(output, "command")))
            }
            _ => None,
        }
        .filter(|command| !command.is_empty());
        let (status, error) = self.failure();
        let action = match self.name {
            "parse_file" => self
                .output
                .and_then(|output| output.get("source"))
                .and_then(|source| string(source, "path"))
                .filter(|path| !path.is_empty())
                .map(|path| ToolDisplayAction::OpenFile {
                    path: path.to_owned(),
                }),
            "scrape_url" | "screenshot_url" => string(self.input, "url")
                .map(str::trim)
                .filter(|url| url.starts_with("https://") || url.starts_with("http://"))
                .map(|url| ToolDisplayAction::OpenUrl {
                    url: url.to_owned(),
                }),
            "card_checkout"
                if self.output.and_then(|output| string(output, "status"))
                    == Some("card_required") =>
            {
                Some(ToolDisplayAction::SaveCard)
            }
            _ => None,
        };
        ToolDisplay {
            label: label(self.name),
            summary: self.summary(command),
            commands: command
                .into_iter()
                .map(|text| CommandHighlight {
                    start: 0,
                    text: text.to_owned(),
                })
                .collect(),
            status,
            error,
            action,
        }
    }

    fn failure(&self) -> (ToolStatus, Option<String>) {
        let output_error = self.output.and_then(|output| string(output, "error"));
        let output_status = self.output.and_then(|output| string(output, "status"));
        let status = match (self.status, output_error, output_status) {
            (ToolStatus::Completed, Some(_), Some("cancelled")) => ToolStatus::Cancelled,
            (ToolStatus::Completed, Some(_), Some("failed")) => ToolStatus::Failed,
            (status, ..) => status,
        };
        let error = match status {
            ToolStatus::Running | ToolStatus::Completed => None,
            ToolStatus::Cancelled => {
                Some(output_error.unwrap_or("Tool stopped before completion."))
            }
            ToolStatus::Failed => Some(output_error.unwrap_or("Executor job failed.")),
        };
        (status, error.map(str::to_owned))
    }

    fn summary(&self, command: Option<&str>) -> String {
        let input = self.input;
        let field = |key| string(input, key);
        match self.name {
            "apply_patch" => patch_result(self.output)
                .or_else(|| field("patch").and_then(patch_input))
                .unwrap_or_else(|| "Patch".into()),
            "ask_question" => field("question").unwrap_or("Question").into(),
            "await_question" | "poll_question" => "Waiting for answer".into(),
            "spawn_subagent" => field("prompt").unwrap_or("Child agent").into(),
            "control_subagent" => match field("action") {
                Some("send") => field("prompt").unwrap_or("Message child agent"),
                Some("stop") => "Stop child agent",
                Some("answer_question") => "Answered question",
                _ => field("threadId").unwrap_or("Child agent"),
            }
            .into(),
            "poll_subagent" => field("threadId").unwrap_or("Child agent").into(),
            "list_subagents" | "list_subagent_models" => String::new(),
            "list_threads" => field("query").unwrap_or_default().into(),
            "download_threads" => input
                .get("threadIds")
                .and_then(Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_else(|| "Threads".into()),
            "check_docs" => field("query")
                .or_else(|| field("path"))
                .unwrap_or("Docs")
                .into(),
            "bind_artifact" | "add_artifact" | "create_artifact" | "edit_artifact"
            | "save_artifact" | "delete_artifact" => self.artifact_summary(),
            "update_artifact" => field("title").unwrap_or("Updated artifact").into(),
            "list_artifacts" => artifact_list(self.output),
            "exec_cmd" | "exec_command" => match command {
                Some(cmd) => match field("workdir") {
                    Some(cwd) if !cwd.trim().is_empty() && cwd != "." => {
                        format!("{cmd} (cwd {cwd})")
                    }
                    _ => cmd.into(),
                },
                None => "Command".into(),
            },
            name if is_session_command(name) => {
                if let Some(command) = command {
                    return command.into();
                }
                let session_id = self.session_id().filter(|id| !id.is_empty());
                let session = session_id
                    .map(|id| format!("Session {id}"))
                    .unwrap_or_else(|| "Command session".into());
                if matches!(name, "control_cmd" | "control_command") {
                    if field("action") == Some("terminate") {
                        format!("Terminate {session}")
                    } else {
                        format!("Write to {session}")
                    }
                } else {
                    session
                }
            }
            "get_workspace_instructions" => "Workspace instructions".into(),
            "card_checkout" => match (field("amount"), field("currency")) {
                (Some(amount), Some(currency)) if !amount.is_empty() && !currency.is_empty() => {
                    format!("Paying {amount} {}", currency.to_uppercase())
                }
                _ => "Payment".into(),
            },
            "report_order" => {
                if field("outcome") == Some("failed") {
                    "Recorded failed payment".into()
                } else if let Some(number) = field("orderNumber").filter(|s| !s.is_empty()) {
                    format!("Recorded order {number}")
                } else {
                    "Order".into()
                }
            }
            "poll_checkout" => "Waiting for approval".into(),
            "read_skill" => field("name")
                .filter(|name| !name.is_empty())
                .map(|name| format!("${name}"))
                .unwrap_or_else(|| "Skill".into()),
            "scrape_url" | "screenshot_url" => field("url").unwrap_or("URL").into(),
            "parse_file" => field("path")
                .or_else(|| field("url"))
                .unwrap_or("File")
                .into(),
            "set_cwd" => field("path").unwrap_or("Directory").into(),
            "link_prs" => input
                .get("pullRequests")
                .and_then(Value::as_array)
                .map(|prs| {
                    prs.iter()
                        .map(|pr| pull_request(pr).unwrap_or_else(|| "PR".into()))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_else(|| "Pull requests".into()),
            "poll_pr" => pull_request(input).unwrap_or_else(|| "Pull request".into()),
            "service_search" => field("query").unwrap_or("Services").into(),
            "service_describe" => input
                .get("paths")
                .and_then(Value::as_array)
                .map(|paths| {
                    paths
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_else(|| "Service tools".into()),
            "service_call" => field("path").unwrap_or("Service tool").into(),
            "request_connector" => field("connector")
                .or_else(|| {
                    input
                        .get("custom")
                        .and_then(|custom| string(custom, "name"))
                })
                .unwrap_or("Connector")
                .into(),
            "web_search" => {
                let mut summary = field("query").unwrap_or("Web search").to_owned();
                if let Some(results) = self
                    .output
                    .and_then(|output| output.get("results"))
                    .and_then(Value::as_array)
                {
                    let count = results.len();
                    summary.push_str(&format!(
                        " ({count} result{})",
                        if count == 1 { "" } else { "s" }
                    ));
                }
                summary
            }
            "lookup_parts" => input
                .get("parts")
                .and_then(Value::as_array)
                .map(|parts| {
                    parts
                        .iter()
                        .map(|part| string(part, "part").unwrap_or("Part"))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_else(|| "Parts".into()),
            name => titleize(name),
        }
    }

    fn artifact_summary(&self) -> String {
        let output = self.output;
        string(self.input, "path")
            .or_else(|| string(self.input, "localPath"))
            .or_else(|| output.and_then(|output| string(output, "localPath")))
            .or_else(|| output.and_then(|output| string(output, "path")))
            .or_else(|| output.and_then(|output| string(output, "title")))
            .or_else(|| string(self.input, "title"))
            .or_else(|| string(self.input, "artifactId"))
            .unwrap_or("Artifact")
            .into()
    }
}

fn label(name: &str) -> Option<String> {
    Some(
        match name {
            "exec_cmd" | "exec_command" | "apply_patch" | "ask_question" | "await_question"
            | "poll_question" | "read_skill" | "scrape_url" | "web_search" => return None,
            name if is_session_command(name) => return None,
            "spawn_subagent" => "Delegated Tasks",
            "control_subagent" => "Controlled Subagents",
            "poll_subagent" => "Polled Subagents",
            "poll_pr" => "Polled PRs",
            "list_subagents" => "Listed Subagents",
            "list_subagent_models" => "Listed Subagent Models",
            "list_threads" => "Listed Threads",
            "download_threads" => "Downloaded Threads",
            "check_docs" => "Checked Docs",
            "bind_artifact" | "add_artifact" => "Bound Artifact",
            "create_artifact" => "Created Artifact",
            "edit_artifact" | "update_artifact" => "Updated Artifact",
            "list_artifacts" => "Listed Artifacts",
            "save_artifact" => "Saved Artifact",
            "delete_artifact" => "Deleted Artifact",
            "get_workspace_instructions" => "Read Instructions",
            "card_checkout" => "Card Checkout",
            "poll_checkout" => "Checkout Approval",
            "report_order" => "Recorded Order",
            "parse_file" => "Parsed File",
            "screenshot_url" => "Captured Screenshot",
            "set_cwd" => "Changed Directory",
            "link_prs" => "Linked PRs",
            "lookup_parts" => "Checked Parts",
            "service_search" => "Searched Services",
            "service_describe" => "Described Service Tools",
            "service_call" => "Called Service Tool",
            "request_connector" => "Requested Connector",
            name => return Some(titleize(name)),
        }
        .into(),
    )
}

pub fn is_session_command(name: &str) -> bool {
    matches!(
        name,
        "control_cmd" | "control_command" | "poll_cmd" | "poll_command" | "write_stdin"
    )
}

/// Reads session commands from `command-logs/sessions`. Misses are read again, since a
/// session's file can appear after its first call.
pub struct SessionCommands {
    transcript_dir: PathBuf,
    found: HashMap<String, Option<String>>,
}

impl SessionCommands {
    pub fn new(transcript_dir: PathBuf) -> Self {
        Self {
            transcript_dir,
            found: HashMap::new(),
        }
    }

    pub fn get(&mut self, session: &str) -> Option<&str> {
        if !self.found.contains_key(session) {
            let command = self.read(session);
            self.found.insert(session.to_owned(), command);
        }
        self.found.get(session)?.as_deref()
    }

    fn read(&self, session: &str) -> Option<String> {
        let id = uuid::Uuid::parse_str(session).ok()?;
        let path = self
            .transcript_dir
            .join("command-logs/sessions")
            .join(format!("{id}.json"));
        let history: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
        Some(string(&history, "command")?.to_owned())
    }
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn titleize(name: &str) -> String {
    name.split('_')
        .map(|segment| {
            let mut chars = segment.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().chain(chars).collect::<String>())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn pull_request(input: &Value) -> Option<String> {
    let repository = string(input, "repository")?;
    let number = input.get("number")?.as_u64()?;
    Some(format!("{repository}#{number}"))
}

fn artifact_list(output: Option<&Value>) -> String {
    let artifacts = output.and_then(|output| {
        output
            .as_array()
            .or_else(|| output.get("artifacts").and_then(Value::as_array))
    });
    match artifacts.map(Vec::len) {
        Some(1) => "1 artifact".into(),
        Some(count) => format!("{count} artifacts"),
        None => "Artifacts".into(),
    }
}

fn unique_paths(paths: impl IntoIterator<Item = String>) -> Option<String> {
    let mut unique = Vec::new();
    for path in paths {
        if !unique.contains(&path) {
            unique.push(path);
        }
    }
    (!unique.is_empty()).then(|| unique.join("\n"))
}

fn patch_result(output: Option<&Value>) -> Option<String> {
    let changes = output?.get("changes")?.as_array()?;
    unique_paths(changes.iter().filter_map(|change| {
        string(change, "path")
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
    }))
}

fn patch_input(patch: &str) -> Option<String> {
    let mut paths = Vec::new();
    for line in patch.split('\n') {
        if line.starts_with("diff --git ") {
            if let Some((_, path)) = line.rsplit_once(" \"b/") {
                paths.push(path.strip_suffix('"').unwrap_or(path).to_owned());
            } else if let Some((_, path)) = line.rsplit_once(" b/") {
                paths.push(path.to_owned());
            }
        } else if let Some(path) = [
            "*** Add File: ",
            "*** Copy File: ",
            "*** Delete File: ",
            "*** Update File: ",
        ]
        .iter()
        .find_map(|header| line.strip_prefix(header))
        {
            paths.push(path.trim().to_owned());
        } else if let Some(path) = ["*** Copy to: ", "*** Move to: "]
            .iter()
            .find_map(|header| line.strip_prefix(header))
            && let Some(last) = paths.last_mut()
        {
            *last = path.trim().to_owned();
        }
    }
    unique_paths(paths)
}

#[cfg(test)]
mod tests;
