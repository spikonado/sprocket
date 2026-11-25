use std::borrow::Cow;
use std::sync::LazyLock;

use regex::{Captures, Regex, Replacer};
use serde_json::Value;

// Matches where a token run starts, or after a diff marker such as `-sk-…`. Group 1 keeps
// that boundary, since the `regex` crate has no lookbehind.
const TOKEN_START: &str = r"(^|[^A-Za-z0-9_-]|(?:^|\s)-)";

const KNOWN_FORMATS: [(&str, &str); 9] = [
    (
        "private-key",
        r"()-----BEGIN [A-Z ]{0,20}PRIVATE KEY-----(?s:.)*?-----END [A-Z ]{0,20}PRIVATE KEY-----",
    ),
    (
        "jwt",
        r"{start}eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
    ),
    ("anthropic-key", r"{start}sk-ant-[A-Za-z0-9_-]{20,}"),
    (
        "openai-key",
        r"{start}sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}",
    ),
    (
        "github-token",
        r"()\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})",
    ),
    ("aws-access-key", r"()\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    ("google-api-key", r"()\bAIza[A-Za-z0-9_-]{35}"),
    ("slack-token", r"{start}xox[abposr]-[A-Za-z0-9-]{10,}"),
    ("stripe-key", r"()\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}"),
];

struct Rules {
    known_formats: Vec<(Regex, String)>,
    url_password: Regex,
    candidate: Regex,
}

static RULES: LazyLock<Rules> = LazyLock::new(|| Rules {
    known_formats: KNOWN_FORMATS
        .iter()
        .map(|(label, pattern)| {
            let pattern = Regex::new(&pattern.replace("{start}", TOKEN_START))
                .expect("secret format patterns are valid");
            (pattern, format!("${{1}}{}", placeholder(label)))
        })
        .collect(),
    url_password: Regex::new(r"(?i)(\b[a-z][a-z0-9+.-]{0,30}://[^\s/:@]{1,256}:)[^\s/@]{1,256}@")
        .expect("URL password pattern is valid"),
    // Lockfile and Nix integrity hashes are long and random but not secret, so they are
    // matched whole and kept. `=` only ends a candidate, as base64 padding, so the value of
    // `NAME=value` starts its own.
    candidate: Regex::new(r"(sha(?:1|256|384|512)-[A-Za-z0-9+/]+=*)|[A-Za-z0-9_+]+=*")
        .expect("candidate pattern is valid"),
});

fn placeholder(label: &str) -> String {
    format!("[redacted:{label}]")
}

fn entropy(token: &str) -> f64 {
    let mut counts = [0usize; 256];
    for byte in token.bytes() {
        counts[usize::from(byte)] += 1;
    }
    let length = token.len() as f64;
    counts
        .iter()
        .filter(|count| **count > 0)
        .map(|count| {
            let share = *count as f64 / length;
            -share * share.log2()
        })
        .sum()
}

// Requiring mixed case and digits keeps commit SHAs, Convex IDs, ULIDs and UUIDs intact.
// The entropy bar follows the length because random strings gain entropy with length and
// identifiers made of words don't.
fn is_high_entropy(token: &str) -> bool {
    token.bytes().any(|byte| byte.is_ascii_lowercase())
        && token.bytes().any(|byte| byte.is_ascii_uppercase())
        && token.bytes().filter(u8::is_ascii_digit).count() >= 2
        && entropy(token) >= ((token.len() as f64).log2() - 0.6).min(4.5)
}

// A candidate ends at `_`, and nothing after the `_` starts one, so prefixed IDs such as
// `user_01KX…` stay intact.
fn redact_candidate(captures: &Captures<'_>) -> String {
    let token = &captures[0];
    let head = token.split('_').next().unwrap_or_default();
    if captures.get(1).is_some() || head.len() < 24 || !is_high_entropy(head) {
        return token.to_string();
    }
    format!("{}{}", placeholder("high-entropy"), &token[head.len()..])
}

fn replace_all(text: &mut String, pattern: &Regex, replacement: impl Replacer) {
    if let Cow::Owned(replaced) = pattern.replace_all(text, replacement) {
        *text = replaced;
    }
}

pub(crate) fn redact_secrets(text: &str) -> String {
    let rules = &*RULES;
    let mut redacted = text.to_string();
    for (pattern, replacement) in &rules.known_formats {
        replace_all(&mut redacted, pattern, replacement.as_str());
    }
    let password = format!("${{1}}{}@", placeholder("password"));
    replace_all(&mut redacted, &rules.url_password, password.as_str());
    replace_all(&mut redacted, &rules.candidate, redact_candidate);
    redacted
}

pub(crate) fn redact_json(value: &mut Value) {
    match value {
        Value::String(text) => *text = redact_secrets(text),
        Value::Array(items) => items.iter_mut().for_each(redact_json),
        Value::Object(fields) => fields.values_mut().for_each(redact_json),
        _ => {}
    }
}

// Reasoning stays as the provider returned it, since providers replay it, and Claude rejects
// thinking whose signed text changed.
pub(crate) fn redact_completion_item(item: &mut Value) {
    match item.get("type").and_then(Value::as_str) {
        Some("reasoning") => {}
        Some("tool-call") => {
            let Some(input) = item.get_mut("input") else {
                return;
            };
            let original = input.clone();
            redact_json(input);
            // The native item keeps the model's spelling of the arguments when it differs from
            // the canonical JSON. Replay rebuilds them from `input` once they are gone.
            if *input != original
                && let Some(native) = item
                    .pointer_mut("/providerMetadata/rigNative")
                    .and_then(Value::as_object_mut)
            {
                native.remove("arguments");
            }
        }
        _ => {
            if let Some(Value::String(text)) = item.get_mut("text") {
                *text = redact_secrets(text);
            }
        }
    }
}

#[cfg(test)]
mod tests;
