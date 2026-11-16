use serde::de::DeserializeOwned;
use serde_json::json;

use super::*;

fn parse<T: DeserializeOwned>(thread_id: &str, mut extra: serde_json::Value) -> bool {
    extra["userId"] = "user-1".into();
    extra["threadId"] = thread_id.into();
    serde_json::from_value::<T>(extra).is_ok()
}

#[test]
fn request_thread_ids_reject_unsafe_paths() {
    for thread_id in [
        "", "blobs", "BLOBS", "../other", "a\\b", "C:", "blobs ", "thread-1",
    ] {
        let valid = thread_id == "thread-1";
        assert_eq!(parse::<TranscriptRowsScope>(thread_id, json!({})), valid);
        assert_eq!(
            parse::<TranscriptRowScope>(thread_id, json!({"rowId":"text:run:source:0"})),
            valid
        );
        assert_eq!(
            parse::<TranscriptAttachmentRequest>(thread_id, json!({"storageId":"storage-1"})),
            valid
        );
    }
}

#[test]
fn row_ids_are_opaque_and_page_numbers_use_the_part_number_range() {
    assert!(parse::<TranscriptRowScope>(
        "thread-1",
        json!({"rowId":"text:run:source/with.dots:0"})
    ));
    assert!(parse::<TranscriptRowsScope>(
        "thread-1",
        json!({"before": 200})
    ));
    for before in [json!(-1), json!(1.5), json!(u64::MAX)] {
        assert!(!parse::<TranscriptRowsScope>(
            "thread-1",
            json!({"before":before})
        ));
    }
    for row_id in ["".into(), "row\n1".into(), "x".repeat(513)] {
        assert!(!parse::<TranscriptRowScope>(
            "thread-1",
            json!({"rowId":row_id})
        ));
    }
}
