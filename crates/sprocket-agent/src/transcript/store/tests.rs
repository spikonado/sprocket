use super::*;
use crate::transcript::types::{TranscriptPartKind, TranscriptPromptBody};

fn prompt(number: u32, text: &str) -> TranscriptPart {
    TranscriptPart {
        number,
        source_key: format!("prompt:{number}"),
        kind: TranscriptPartKind::Prompt,
        run_id: format!("run-{number}"),
        created_at: None,
        prompt: Some(TranscriptPromptBody {
            text: text.to_string(),
            image_uploads: Vec::new(),
        }),
        completion: None,
        tool: None,
        work: Default::default(),
    }
}

#[tokio::test]
async fn only_missing_state_is_treated_as_an_empty_cache() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_path_buf());
    assert_eq!(
        store.load_state("user", "thread").await.unwrap(),
        TranscriptState::new("user".into(), "thread".into())
    );
    let path = store.thread_dir("user", "thread").join("state.json");
    std::fs::create_dir_all(&path).unwrap();
    let error = store.load_state("user", "thread").await.unwrap_err();
    assert!(error.to_string().contains(path.to_str().unwrap()));
    std::fs::remove_dir(&path).unwrap();
    std::fs::write(&path, "invalid JSON").unwrap();
    let error = store.load_state("user", "thread").await.unwrap_err();
    assert!(error.to_string().contains(path.to_str().unwrap()));
    assert_eq!(std::fs::read_to_string(path).unwrap(), "invalid JSON");
}

#[tokio::test]
async fn independent_state_writers_do_not_share_temporary_files() {
    let dir = tempfile::tempdir().unwrap();
    let writes = (0..32).map(|number| {
        let store = TranscriptStore::new(dir.path().to_path_buf());
        async move {
            let mut state = TranscriptState::new("user".into(), "thread".into());
            state.remote_total_parts = number;
            store.save_state("user", "thread", &state).await
        }
    });
    for result in futures::future::join_all(writes).await {
        result.expect("concurrent state publication should succeed");
    }
    let store = TranscriptStore::new(dir.path().to_path_buf());
    let state = store.load_state("user", "thread").await.unwrap();
    assert!(state.remote_total_parts < 32);
    let files = std::fs::read_dir(store.thread_dir("user", "thread"))
        .unwrap()
        .count();
    assert_eq!(files, 2, "only state.json and parts should remain");
}

#[tokio::test]
async fn shared_store_preserves_concurrent_part_updates() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_path_buf());
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
    let numbers = (0..32).collect::<Vec<_>>();
    let parts = store.read_parts("user", "thread", &numbers).await.unwrap();
    assert_eq!(parts.len(), numbers.len());
    let state = store.load_state("user", "thread").await.unwrap();
    assert!(numbers.iter().all(|number| state.covers(*number)));
}

#[tokio::test]
async fn preserves_created_at_on_disk() {
    let dir = std::env::temp_dir().join(format!("sprocket-created-at-{}", uuid::Uuid::new_v4()));
    let store = TranscriptStore::new(dir.clone());
    let mut part = prompt(0, "hello");
    part.created_at = Some(1_700_000_000_000);
    store.append_parts("user", "thread", &[part]).await.unwrap();
    let read = store.read_parts("user", "thread", &[0]).await.unwrap();
    assert_eq!(read[0].created_at, Some(1_700_000_000_000));
    let chunk = tokio::fs::read_to_string(
        store
            .thread_dir("user", "thread")
            .join("parts")
            .join("00000000.jsonl"),
    )
    .await
    .unwrap();
    assert!(chunk.contains("\"createdAt\":1700000000000"));
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn appends_reads_and_clears_parts() {
    let dir = std::env::temp_dir().join(format!("sprocket-transcript-{}", uuid::Uuid::new_v4()));
    let store = TranscriptStore::new(dir.clone());
    store
        .append_parts(
            "user",
            "thread",
            &[prompt(0, "a"), prompt(1, "b"), prompt(2, "c")],
        )
        .await
        .unwrap();
    store
        .save_state("user", "thread", &{
            let mut state = store.load_state("user", "thread").await.unwrap();
            state.remote_total_parts = 3;
            state
        })
        .await
        .unwrap();
    let parts = store.read_parts("user", "thread", &[1, 2]).await.unwrap();
    assert_eq!(
        parts
            .iter()
            .map(|part| part.prompt.as_ref().unwrap().text.as_str())
            .collect::<Vec<_>>(),
        vec!["b", "c"]
    );
    for invalid_id in ["", "blobs", "BLOBS", "blobs ", "../thread"] {
        assert!(store.clear_thread("user", invalid_id).await.is_err());
    }
    assert_eq!(
        store
            .read_parts("user", "thread", &[0, 1, 2])
            .await
            .unwrap()
            .len(),
        3
    );
    let command_log = store
        .thread_dir("user", "thread")
        .join("command-logs/output.log");
    tokio::fs::create_dir_all(command_log.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&command_log, b"command output")
        .await
        .unwrap();
    store.clear_thread("user", "thread").await.unwrap();
    assert!(
        store
            .read_parts("user", "thread", &[0, 1, 2])
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .load_state("user", "thread")
            .await
            .unwrap()
            .remote_total_parts,
        0
    );
    assert_eq!(
        tokio::fs::read(command_log).await.unwrap(),
        b"command output"
    );
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn recovers_a_torn_final_jsonl_line() {
    let dir = std::env::temp_dir().join(format!("sprocket-transcript-{}", uuid::Uuid::new_v4()));
    let store = TranscriptStore::new(dir.clone());
    store
        .append_parts("user", "thread", &[prompt(0, "ok")])
        .await
        .unwrap();
    let chunk = store
        .thread_dir("user", "thread")
        .join("parts")
        .join("00000000.jsonl");
    let mut contents = tokio::fs::read(&chunk).await.unwrap();
    contents.extend_from_slice(b"{\"number\":1,");
    tokio::fs::write(&chunk, contents).await.unwrap();
    let parts = store.read_parts("user", "thread", &[0, 1]).await.unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].number, 0);
    assert_eq!(
        store.missing_numbers("user", "thread", 0, 2).await.unwrap(),
        vec![1]
    );
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn append_parts_keeps_the_first_write_for_a_number() {
    let dir =
        std::env::temp_dir().join(format!("sprocket-transcript-dup-{}", uuid::Uuid::new_v4()));
    let store = TranscriptStore::new(dir.clone());
    store
        .append_parts(
            "user",
            "thread",
            &[prompt(0, "first"), prompt(0, "dup"), prompt(1, "second")],
        )
        .await
        .unwrap();
    store
        .append_parts(
            "user",
            "thread",
            &[prompt(1, "ignored"), prompt(2, "third")],
        )
        .await
        .unwrap();
    let parts = store
        .read_parts("user", "thread", &[0, 1, 2])
        .await
        .unwrap();
    assert_eq!(
        parts
            .iter()
            .map(|part| part.prompt.as_ref().unwrap().text.as_str())
            .collect::<Vec<_>>(),
        vec!["first", "second", "third"]
    );
    let chunk = store
        .thread_dir("user", "thread")
        .join("parts")
        .join("00000000.jsonl");
    let contents = tokio::fs::read_to_string(&chunk).await.unwrap();
    assert_eq!(
        contents
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count(),
        3
    );
    let _ = tokio::fs::remove_dir_all(dir).await;
}
