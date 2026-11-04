use serde::{Deserialize, Serialize};

use super::PullRequestState;

mod reader;
pub use reader::ActivityReader;

const SNIPPET_CHARS: usize = 300;
const MARKUP_TAGS: &[&str] = &[
    "a", "b", "br", "code", "details", "em", "img", "p", "strong", "sub", "summary", "sup",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckOutcome {
    Pending,
    Passed,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct Check {
    pub name: String,
    #[serde(skip)]
    pub outcome: CheckOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub required: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Remark {
    #[serde(skip)]
    pub id: String,
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub body: String,
    /// RFC 3339 in UTC, as GitHub writes it, so it orders as text.
    #[serde(skip)]
    pub at: String,
    pub url: String,
}

#[derive(Clone, Debug)]
pub struct Activity {
    pub state: PullRequestState,
    pub head_sha: String,
    /// `None` while GitHub is still working it out.
    pub conflicting: Option<bool>,
    pub checks: Vec<Check>,
    /// Everyone's but the viewer's, oldest first.
    pub remarks: Vec<Remark>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Change {
    Merged,
    Closed,
    ChecksFailed,
    ChecksFinished,
    RequiredChecksPassed,
    Conflicting,
    NewComments,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seen {
    open: bool,
    head_sha: String,
    failed_checks: Vec<String>,
    checks_finished: bool,
    required_passed: bool,
    conflicting: bool,
    remarks_through: Option<String>,
    /// Remarks at `remarks_through`, since GitHub stamps to the second.
    remark_ids: Vec<String>,
}

impl Seen {
    pub fn first_look(activity: &Activity) -> Self {
        let (remarks_through, remark_ids) = seen_through(None, &[], &activity.remarks);
        Self {
            open: true,
            head_sha: activity.head_sha.clone(),
            failed_checks: Vec::new(),
            checks_finished: false,
            required_passed: false,
            conflicting: false,
            remarks_through,
            remark_ids,
        }
    }
}

#[derive(Debug)]
pub struct Report {
    pub changes: Vec<Change>,
    pub new_remarks: Vec<Remark>,
    pub next: Seen,
}

pub fn compare(seen: &Seen, activity: &Activity) -> Report {
    let mut changes = Vec::new();
    let open = activity.state == PullRequestState::Open;
    if seen.open && !open {
        changes.push(match activity.state {
            PullRequestState::Merged => Change::Merged,
            _ => Change::Closed,
        });
    }

    let same_head = seen.head_sha == activity.head_sha;
    let failed_checks: Vec<String> = activity
        .checks
        .iter()
        .filter(|check| check.outcome == CheckOutcome::Failed)
        .map(|check| check.name.clone())
        .collect();
    if failed_checks
        .iter()
        .any(|name| !same_head || !seen.failed_checks.contains(name))
    {
        changes.push(Change::ChecksFailed);
    }
    let checks_finished = !activity.checks.is_empty()
        && activity
            .checks
            .iter()
            .all(|check| check.outcome != CheckOutcome::Pending);
    let mut required = activity
        .checks
        .iter()
        .filter(|check| check.required)
        .peekable();
    let required_passed =
        required.peek().is_some() && required.all(|check| check.outcome == CheckOutcome::Passed);
    if checks_finished && !(same_head && seen.checks_finished) {
        changes.push(Change::ChecksFinished);
    } else if required_passed && !(same_head && seen.required_passed) {
        changes.push(Change::RequiredChecksPassed);
    }

    if activity.conflicting == Some(true) && !seen.conflicting {
        changes.push(Change::Conflicting);
    }

    let through = seen.remarks_through.as_deref();
    let new_remarks: Vec<Remark> = activity
        .remarks
        .iter()
        .filter(|remark| match through {
            None => true,
            Some(through) => {
                remark.at.as_str() > through
                    || (remark.at == through && !seen.remark_ids.contains(&remark.id))
            }
        })
        .cloned()
        .collect();
    if !new_remarks.is_empty() {
        changes.push(Change::NewComments);
    }
    let (remarks_through, remark_ids) = seen_through(through, &seen.remark_ids, &new_remarks);

    Report {
        changes,
        new_remarks,
        next: Seen {
            open,
            head_sha: activity.head_sha.clone(),
            failed_checks,
            checks_finished,
            required_passed,
            conflicting: activity.conflicting.unwrap_or(seen.conflicting),
            remarks_through,
            remark_ids,
        },
    }
}

/// `fresh` are all at or after `through`.
fn seen_through(
    through: Option<&str>,
    ids: &[String],
    fresh: &[Remark],
) -> (Option<String>, Vec<String>) {
    let Some(latest) = fresh.iter().map(|remark| remark.at.as_str()).max() else {
        return (through.map(str::to_owned), ids.to_vec());
    };
    let mut latest_ids = if through == Some(latest) {
        ids.to_vec()
    } else {
        Vec::new()
    };
    latest_ids.extend(
        fresh
            .iter()
            .filter(|remark| remark.at == latest)
            .map(|remark| remark.id.clone()),
    );
    (Some(latest.to_owned()), latest_ids)
}

/// The start of `body` as plain text. Review bots wrap findings in HTML, and
/// an image's alt text can carry a finding's priority.
fn snippet(body: &str) -> String {
    let mut text = String::new();
    let mut rest = body;
    while let Some(start) = rest.find('<') {
        text.push_str(&rest[..start]);
        rest = &rest[start..];
        let markup_len = if let Some(comment) = rest.strip_prefix("<!--") {
            comment
                .find("-->")
                .map(|end| "<!--".len() + end + "-->".len())
        } else if is_markup_tag(rest) {
            rest.find('>').map(|end| end + 1)
        } else {
            None
        };
        let Some(markup_len) = markup_len else {
            text.push('<');
            rest = &rest[1..];
            continue;
        };
        let tag = &rest[..markup_len];
        text.push(' ');
        if let Some(alt) = tag
            .strip_prefix("<img")
            .and_then(|attributes| attributes.split_once("alt=\""))
            .and_then(|(_, alt)| alt.split_once('"'))
            .map(|(alt, _)| alt)
        {
            text.push_str(alt);
            text.push(' ');
        }
        rest = &rest[markup_len..];
    }
    text.push_str(rest);

    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= SNIPPET_CHARS {
        return text;
    }
    let cut: String = text.chars().take(SNIPPET_CHARS - 3).collect();
    format!("{}...", cut.trim_end())
}

fn is_markup_tag(text: &str) -> bool {
    let name = text[1..].strip_prefix('/').unwrap_or(&text[1..]);
    let name_len = name
        .find(|c: char| !c.is_ascii_alphanumeric())
        .unwrap_or(name.len());
    MARKUP_TAGS.contains(&name[..name_len].to_ascii_lowercase().as_str())
        && name[name_len..]
            .chars()
            .next()
            .is_some_and(|c| c == '>' || c == '/' || c.is_whitespace())
}

#[cfg(test)]
mod tests;
