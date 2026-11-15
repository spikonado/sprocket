use serde_json::json;

use super::*;
use crate::types::TranscriptAttachmentMeta;

fn prompt(number: u32, text: &str) -> TranscriptPart {
    serde_json::from_value(json!({
        "number": number,
        "sourceKey": format!("prompt:{number}"),
        "kind": "prompt",
        "runId": format!("run-{}", number / 10),
        "prompt": {"text": text, "imageUploads": []}
    }))
    .unwrap()
}

fn texts(parts: &[TranscriptPart]) -> Vec<&str> {
    parts
        .iter()
        .map(|part| part.prompt.as_ref().unwrap().text.as_str())
        .collect()
}

fn chunk_numbers(store: &TranscriptStore, name: &str) -> Vec<u32> {
    fs::read_to_string(store.thread_dir("user", "thread").join("parts").join(name))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<TranscriptPart>(line).unwrap().number)
        .collect()
}

#[tokio::test]
async fn out_of_order_appends_produce_sorted_chunks_of_one_hundred() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    for numbers in [[205, 3, 150], [0, 199, 100], [2, 1, 4]] {
        let parts: Vec<_> = numbers.iter().map(|number| prompt(*number, "x")).collect();
        store.append_parts("user", "thread", &parts).await.unwrap();
    }
    assert_eq!(chunk_numbers(&store, "00000000.jsonl"), [0, 1, 2, 3, 4]);
    assert_eq!(chunk_numbers(&store, "00000100.jsonl"), [100, 150, 199]);
    assert_eq!(chunk_numbers(&store, "00000200.jsonl"), [205]);
    let range = store
        .read_parts_range("user", "thread", 3, 151)
        .await
        .unwrap();
    assert_eq!(
        range.iter().map(|part| part.number).collect::<Vec<_>>(),
        [3, 4, 100, 150]
    );
    assert_eq!(
        store
            .read_run_range("user", "thread", "run-0")
            .await
            .unwrap(),
        Some(0..5)
    );
}

#[tokio::test]
async fn concurrent_appends_are_all_saved() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let writes = (0..32).map(|number| {
        let store = Arc::clone(&store);
        async move {
            store
                .append_parts("user", "thread", &[prompt(number, "hello")])
                .await
        }
    });
    for result in futures::future::join_all(writes).await {
        result.unwrap();
    }
    assert_eq!(
        chunk_numbers(&store, "00000000.jsonl"),
        (0..32).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn the_first_write_wins_for_a_number_or_source_key_across_chunks() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let mut retried = prompt(150, "retry of 5");
    retried.source_key = "prompt:5".into();
    store
        .append_parts(
            "user",
            "thread",
            &[
                prompt(5, "first"),
                prompt(5, "duplicate"),
                prompt(6, "second"),
            ],
        )
        .await
        .unwrap();
    store
        .append_parts(
            "user",
            "thread",
            &[prompt(6, "ignored"), retried, prompt(7, "third")],
        )
        .await
        .unwrap();
    let parts = store
        .read_parts("user", "thread", &[5, 6, 7, 150])
        .await
        .unwrap();
    assert_eq!(texts(&parts), ["first", "second", "third"]);
    assert!(
        !store
            .thread_dir("user", "thread")
            .join("parts/00000100.jsonl")
            .exists()
    );
}

#[tokio::test]
async fn failed_append_reloads_committed_chunks_before_retrying() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let _lease = store.open_thread("user", "thread").await.unwrap();
    let blocked_chunk = store
        .thread_dir("user", "thread")
        .join("parts/00000100.jsonl");
    fs::create_dir(&blocked_chunk).unwrap();
    let parts = [prompt(0, "saved"), prompt(100, "retry")];

    store
        .append_parts("user", "thread", &parts)
        .await
        .unwrap_err();
    fs::remove_dir(&blocked_chunk).unwrap();
    assert_eq!(store.part_numbers("user", "thread").await.unwrap(), [0]);
    store.append_parts("user", "thread", &parts).await.unwrap();
    let saved = store.read_parts("user", "thread", &[0, 100]).await.unwrap();
    assert_eq!(texts(&saved), ["saved", "retry"]);
}

#[tokio::test]
async fn saves_prompt_attachment_metadata_and_created_at() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let mut part = prompt(0, "photo");
    part.created_at = Some(1_700_000_000_000);
    part.prompt
        .as_mut()
        .unwrap()
        .image_uploads
        .push(TranscriptAttachmentMeta {
            name: "photo.png".into(),
            media_type: "image/png".into(),
            size: 12,
            storage_id: "storage".into(),
            url: Some("https://example.com/expiring".into()),
            local_path: None,
        });
    store.append_parts("user", "thread", &[part]).await.unwrap();
    let read = store.read_parts("user", "thread", &[0]).await.unwrap();
    assert_eq!(read[0].created_at, Some(1_700_000_000_000));
    let metadata = store
        .attachment_metadata("user", "thread", "storage")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(metadata.name, "photo.png");
    assert_eq!(metadata.url, None);
}

#[tokio::test]
async fn old_caches_are_replaced_once_keeping_attachments_and_command_logs() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let thread = store.thread_dir("user", "thread");
    for (path, contents) in [
        ("state.json", "{}"),
        ("display/replica.sqlite", "sqlite"),
        ("parts/00000000.jsonl", "unsorted"),
        ("attachments/storage/metadata.json", "{}"),
        ("command-logs/output.log", "command output"),
    ] {
        fs::create_dir_all(thread.join(path).parent().unwrap()).unwrap();
        fs::write(thread.join(path), contents).unwrap();
    }
    store
        .append_parts("user", "thread", &[prompt(0, "new")])
        .await
        .unwrap();
    assert!(!thread.join("state.json").exists());
    assert!(!thread.join("display").exists());
    assert_eq!(
        fs::read_to_string(thread.join("attachments/storage/metadata.json")).unwrap(),
        "{}"
    );
    assert_eq!(
        fs::read_to_string(thread.join("command-logs/output.log")).unwrap(),
        "command output"
    );

    let reopened = TranscriptStore::new(dir.path().to_owned());
    let parts = reopened.read_parts("user", "thread", &[0]).await.unwrap();
    assert_eq!(texts(&parts), ["new"]);
}

#[tokio::test]
async fn damaged_chunks_and_interrupted_writes_are_discarded_on_open() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    store
        .append_parts("user", "thread", &[prompt(0, "kept"), prompt(100, "torn")])
        .await
        .unwrap();
    let parts_dir = store.thread_dir("user", "thread").join("parts");
    let torn = parts_dir.join("00000100.jsonl");
    let mut contents = fs::read(&torn).unwrap();
    contents.truncate(contents.len() / 2);
    fs::write(&torn, contents).unwrap();
    fs::write(parts_dir.join(".tmp-interrupted"), "partial").unwrap();

    let reopened = TranscriptStore::new(dir.path().to_owned());
    let parts = reopened
        .read_parts("user", "thread", &[0, 100])
        .await
        .unwrap();
    assert_eq!(texts(&parts), ["kept"]);
    let mut names: Vec<_> = fs::read_dir(&parts_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["00000000.jsonl"]);
    reopened
        .append_parts("user", "thread", &[prompt(100, "downloaded again")])
        .await
        .unwrap();
    let parts = reopened.read_parts("user", "thread", &[100]).await.unwrap();
    assert_eq!(texts(&parts), ["downloaded again"]);
}

#[tokio::test]
async fn the_index_lives_only_while_a_lease_is_held() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let loaded = |store: &TranscriptStore| {
        store
            .threads
            .try_lock()
            .unwrap()
            .values()
            .any(|slot| slot.strong_count() != 0)
    };
    store
        .append_parts("user", "thread", &[prompt(0, "a")])
        .await
        .unwrap();
    assert!(!loaded(&store));
    let lease = store.open_thread("user", "thread").await.unwrap();
    assert!(loaded(&store));
    drop(lease);
    assert!(!loaded(&store));
}
