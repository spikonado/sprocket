use serde_json::json;

use super::{TranscriptPart, TranscriptStore, WorkReplica};

fn part(number: u32, run: &str) -> TranscriptPart {
    serde_json::from_value(json!({
        "number": number, "sourceKey": format!("prompt:{run}:{number}"),
        "kind": "prompt", "runId": run,
        "prompt": { "text": format!("prompt {number}"), "imageUploads": [] }
    }))
    .unwrap()
}

#[tokio::test]
async fn number_ranges_are_half_open_sorted_and_allow_download_gaps() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    store
        .with_work_replica("user", "thread", |replica| {
            replica.save_parts(
                "thread",
                &[part(8, "run"), part(2, "older"), part(5, "run")],
            )
        })
        .await
        .unwrap();
    let numbers = store
        .read_parts_range("user", "thread", 2, 8)
        .await
        .unwrap()
        .into_iter()
        .map(|part| part.number)
        .collect::<Vec<_>>();
    assert_eq!(numbers, [2, 5]);
    assert_eq!(
        store.read_run_range("user", "thread", "run").await.unwrap(),
        Some(5..9)
    );
    assert_eq!(
        store
            .read_run_range("user", "thread", "missing")
            .await
            .unwrap(),
        None
    );
}

#[test]
fn saving_the_same_source_is_idempotent_and_conflicts_roll_back() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    replica.save_parts("thread", &[part(1, "run")]).unwrap();
    replica.save_parts("thread", &[part(1, "run")]).unwrap();
    assert_eq!(replica.parts_range(0, 3).unwrap().len(), 1);
    let error = replica
        .save_parts("thread", &[part(2, "run"), part(1, "other")])
        .unwrap_err();
    assert!(error.to_string().contains("transcript source changed"));
    assert!(replica.part(2).unwrap().is_none());
}
