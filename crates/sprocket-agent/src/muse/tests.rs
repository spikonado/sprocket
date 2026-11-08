use serde_json::json;

use super::*;

#[test]
fn served_model_id_follows_contributor_mode_and_the_plan() {
    let list = |ids: &[&str]| json!({ "models": ids.iter().map(|id| json!({ "modelId": id })).collect::<Vec<_>>() });
    let model = "muse-wonder-full-1.0";
    assert_eq!(
        served_model_id(&list(&["muse-spark-1.3", model]), model).as_deref(),
        Some(model)
    );
    assert_eq!(
        served_model_id(&list(&["muse-wonder-full-1.0-contributor"]), model).as_deref(),
        Some("muse-wonder-full-1.0-contributor")
    );
    assert_eq!(served_model_id(&list(&["muse-spark-1.3"]), model), None);
}

#[test]
fn turn_error_explains_usage_limits_and_sign_in() {
    let now_ms = 1_000_000;
    let quota = turn_error(
        &json!({ "message": "rate limited", "quota": { "resetsAtMs": now_ms + 90 * 60_000 } }),
        now_ms,
    );
    assert_eq!(quota["error"]["code"], USAGE_LIMIT_CODE);
    assert!(
        quota["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("resets in about 2 hours"))
    );

    let proxied = turn_error(&json!({ "message": "HTTP 429: quota exceeded" }), now_ms);
    assert_eq!(proxied["error"]["code"], USAGE_LIMIT_CODE);

    let signed_out = turn_error(&json!({ "message": "not logged in" }), now_ms);
    assert_eq!(signed_out["error"]["code"], ERROR_CODE);
    assert_eq!(signed_out["error"]["message"], SIGNED_OUT);

    let other = turn_error(&json!({ "message": "upstream timed out" }), now_ms);
    assert_eq!(other["error"]["message"], "upstream timed out");
}
