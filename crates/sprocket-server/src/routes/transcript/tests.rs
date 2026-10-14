use super::*;
use serde::de::DeserializeOwned;

fn parse<T: DeserializeOwned>(thread_id: &str, mut extra: serde_json::Value) -> bool {
    extra["userId"] = "user-1".into();
    extra["threadId"] = thread_id.into();
    serde_json::from_value::<T>(extra).is_ok()
}

#[test]
fn request_thread_ids_reject_unsafe_paths() {
    use serde_json::json;

    for thread_id in [
        "", "blobs", "BLOBS", "../other", "a\\b", "C:", "blobs ", "thread-1",
    ] {
        let valid = thread_id == "thread-1";
        assert_eq!(parse::<TranscriptScope>(thread_id, json!({})), valid);
        assert_eq!(parse::<DisplayRequest>(thread_id, json!({})), valid);
        assert_eq!(
            parse::<DisplayDetailsRequest>(thread_id, json!({ "rowId": "row-1" })),
            valid
        );
        assert_eq!(
            parse::<TranscriptAttachmentRequest>(thread_id, json!({"storageId": "storage-1"})),
            valid
        );
    }
}

#[test]
fn display_details_row_ids_accept_work_section_keys() {
    use serde_json::json;

    for row_id in [
        "row-1",
        "prompt-1",
        "text-1-0",
        "agent:run1:claim1:1:section:1",
        "agent:j97abc:claim-complete:1:section:2",
        "historical-tool:run1:invocation-1",
    ] {
        let value = json!({"userId": "user-1", "threadId": "thread-1", "rowId": row_id});
        assert!(
            serde_json::from_value::<DisplayDetailsRequest>(value).is_ok(),
            "row ID should be accepted: {row_id}"
        );
    }
    for row_id in ["", "../other", "a\\b", "row 1", "row/1", "row.1"] {
        let value = json!({"userId": "user-1", "threadId": "thread-1", "rowId": row_id});
        assert!(
            serde_json::from_value::<DisplayDetailsRequest>(value).is_err(),
            "row ID should be rejected: {row_id}"
        );
    }
}
