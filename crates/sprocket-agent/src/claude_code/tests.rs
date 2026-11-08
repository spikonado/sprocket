use super::*;
use serde_json::json;

#[test]
fn rejected_rate_limits_report_the_subscription_limit() {
    let result = json!({ "type": "result", "is_error": true, "api_error_status": 429 });
    let info = json!({ "status": "rejected", "resetsAt": 10_000 + 2 * 3_600 });

    let error = result_error(&result, Some(&info), 10_000);

    assert_eq!(error["error"]["code"], USAGE_LIMIT_CODE);
    assert_eq!(
        error["error"]["message"],
        "Your Claude subscription's usage limit has been reached. It resets in about 2 hours. Try again after it resets, or switch to another provider."
    );
}
