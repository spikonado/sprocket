use super::super::questions::QuestionAnswer;
use super::*;

fn snapshot(status: &str, answer: Option<QuestionAnswer>) -> QuestionSnapshot {
    QuestionSnapshot {
        question_id: "q1".to_string(),
        status: status.to_string(),
        answer,
    }
}

fn option(id: &str) -> Option<QuestionAnswer> {
    Some(QuestionAnswer {
        option_id: Some(id.to_string()),
        ..QuestionAnswer::default()
    })
}

fn text(text: &str) -> Option<QuestionAnswer> {
    Some(QuestionAnswer {
        text: Some(text.to_string()),
        ..QuestionAnswer::default()
    })
}

#[test]
fn approvals_allow_only_the_allow_options_and_return_the_users_words() {
    let approval = |status, answer| approval_from_snapshot(&snapshot(status, answer)).unwrap();
    assert_eq!(approval("answered", option("allow")), Approval::Once);
    assert_eq!(approval("answered", option("always")), Approval::Always);
    assert_eq!(
        approval("answered", option("deny")),
        Approval::Denied { text: None }
    );
    assert_eq!(
        approval("answered", text("use the staging project")),
        Approval::Denied {
            text: Some("use the staging project".to_string())
        }
    );
    for status in ["skipped", "timedOut"] {
        assert_eq!(approval(status, None), Approval::Denied { text: None });
    }
    assert!(approval_from_snapshot(&snapshot("cancelled", None)).is_err());
}

fn has_reserved_convex_key(value: &Value) -> bool {
    match value {
        Value::Object(object) => object
            .iter()
            .any(|(key, value)| key.starts_with(['$', '_']) || has_reserved_convex_key(value)),
        Value::Array(items) => items.iter().any(has_reserved_convex_key),
        _ => false,
    }
}

#[test]
fn stored_service_jobs_have_no_keys_convex_rejects() {
    let schema = json!({ "$schema": "https://json-schema.org/draft/2020-12/schema" });
    let mut payload = json!({ "path": "gh/search", "arguments": { "_meta": {} } });
    let mut described = json!({ "tools": [{ "path": "gh/search", "inputSchema": schema }] });
    let mut called = json!({
        "content": [{ "type": "text", "text": "ok", "_meta": {} }],
        "structuredContent": { "_id": 1 },
        "isError": false,
    });
    encode_stored_payload(ServiceCallTool::NAME, &mut payload);
    encode_stored_result(ServiceDescribeTool::NAME, &mut described);
    encode_stored_result(ServiceCallTool::NAME, &mut called);
    for value in [payload, described, called] {
        assert!(!has_reserved_convex_key(&value), "{value}");
    }
}
