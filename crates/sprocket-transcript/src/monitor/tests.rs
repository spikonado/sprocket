use serde_json::json;

use super::*;

fn prompt(number: u32, text: &str) -> TranscriptPart {
    serde_json::from_value(json!({
        "number": number,
        "sourceKey": format!("prompt:{number}"),
        "kind": "prompt",
        "runId": "run",
        "prompt": {"text": text, "imageUploads": []}
    }))
    .unwrap()
}

fn completion(number: u32, items: Vec<JsonValue>) -> TranscriptPart {
    serde_json::from_value(json!({
        "number": number,
        "sourceKey": format!("completion:{number}"),
        "kind": "completion",
        "runId": "run",
        "completion": {"items": items}
    }))
    .unwrap()
}

fn patch_call(invocation: &str) -> JsonValue {
    json!({
        "type": "tool-call",
        "callId": "reused-call-id",
        "toolInvocationId": invocation,
        "name": "apply_patch",
        "input": {"patch": "*** Begin Patch\n*** End Patch"}
    })
}

fn result(number: u32, run: &str, invocation: &str, status: &str) -> TranscriptPart {
    serde_json::from_value(json!({
        "number": number,
        "sourceKey": format!("result:{number}"),
        "kind": "tool",
        "runId": run,
        "tool": {
            "toolInvocationId": invocation,
            "status": status,
            "output": {"changes": [{"operation": "modified", "path": "src/main.rs"}]}
        }
    }))
    .unwrap()
}

async fn local_page(
    store: &TranscriptStore,
    cursor: Option<&str>,
    total: u32,
    max_chars: usize,
) -> MonitorPage {
    let _lease = store.open_thread("user", "thread").await.unwrap();
    read_page(
        store,
        "user",
        "thread",
        MonitorCursor::read("thread", cursor).unwrap(),
        total,
        &MonitorFilter::default(),
        max_chars,
    )
    .await
    .unwrap()
}

async fn cached_page(store: &TranscriptStore, cursor: Option<&str>, total: u32) -> MonitorPage {
    download_monitor_page(
        store,
        "user",
        "thread",
        cursor,
        total,
        &MonitorFilter::default(),
        |_, _| async { anyhow::bail!("cached page must not fetch") },
    )
    .await
    .unwrap()
}

fn texts(entries: &[MonitorEntry]) -> Vec<&str> {
    entries
        .iter()
        .filter_map(|entry| match entry {
            MonitorEntry::Prompt { text, .. } | MonitorEntry::Text { text, .. } => {
                Some(text.as_str())
            }
            MonitorEntry::Patch { .. } => None,
        })
        .collect()
}

fn page_cost(entries: &[MonitorEntry]) -> usize {
    entries
        .iter()
        .map(|entry| match entry {
            MonitorEntry::Prompt { id, text } | MonitorEntry::Text { id, text } => {
                id.chars().count() + 1 + text.chars().count()
            }
            MonitorEntry::Patch { id, changes, .. } => {
                id.chars().count() + 1 + changes.iter().map(patch_change_cost).sum::<usize>()
            }
        })
        .sum()
}

async fn collect_pages(
    store: &TranscriptStore,
    mut cursor: Option<String>,
    total: u32,
    max_chars: usize,
) -> (Vec<MonitorEntry>, String) {
    let mut entries = Vec::new();
    for _ in 0..64 {
        let page = local_page(store, cursor.as_deref(), total, max_chars).await;
        assert!(page_cost(&page.entries) <= max_chars);
        entries.extend(page.entries);
        if !page.has_more {
            return (entries, page.next_cursor);
        }
        cursor = Some(page.next_cursor);
    }
    panic!("monitor paging did not finish");
}

#[tokio::test]
async fn sparse_cache_downloads_missing_parts_newest_first_but_reports_chronologically() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let _lease = store.open_thread("user", "thread").await.unwrap();
    let parts: Vec<_> = (0..205)
        .map(|number| prompt(number, &number.to_string()))
        .collect();
    let cached = [parts[0].clone(), parts[102].clone(), parts[204].clone()];
    store.append_parts("user", "thread", &cached).await.unwrap();
    let mut fetched = Vec::new();
    let page = download_monitor_page(
        &store,
        "user",
        "thread",
        None,
        205,
        &MonitorFilter::default(),
        |start, end| {
            // Exercise short server pages as well as sparse local chunks.
            let batch: Vec<_> = (start..end).rev().take(17).collect();
            fetched.extend(batch.iter().copied());
            let parts: Vec<_> = batch
                .iter()
                .map(|number| parts[*number as usize].clone())
                .collect();
            async move { Ok(parts) }
        },
    )
    .await
    .unwrap();
    assert_eq!(
        fetched,
        (1..204)
            .rev()
            .filter(|number| *number != 102)
            .collect::<Vec<_>>()
    );
    assert_eq!(
        texts(&page.entries),
        (0..205)
            .map(|number| number.to_string())
            .collect::<Vec<_>>()
    );
    assert!(!page.has_more);

    assert_eq!(page, cached_page(&store, None, 205).await);
}

#[tokio::test]
async fn resumed_polls_download_missing_parts_before_the_cursor() {
    let parts = [
        completion(0, vec![patch_call("inv")]),
        result(1, "run", "inv", "completed"),
        prompt(2, "seen"),
        prompt(3, "new"),
    ];
    let first_dir = tempfile::tempdir().unwrap();
    let first = TranscriptStore::new(first_dir.path().to_owned());
    let _first_lease = first.open_thread("user", "thread").await.unwrap();
    first
        .append_parts("user", "thread", &parts[..3])
        .await
        .unwrap();
    let seen = local_page(&first, None, 3, 1_000).await;
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let _lease = store.open_thread("user", "thread").await.unwrap();
    store
        .append_parts("user", "thread", &parts[3..])
        .await
        .unwrap();
    let mut fetched = Vec::new();
    let page = download_monitor_page(
        &store,
        "user",
        "thread",
        Some(&seen.next_cursor),
        4,
        &MonitorFilter::default(),
        |start, end| {
            fetched.push((start, end));
            let page: Vec<_> = parts[start as usize..end as usize]
                .iter()
                .rev()
                .cloned()
                .collect();
            async move { Ok(page) }
        },
    )
    .await
    .unwrap();
    assert_eq!(fetched, [(0, 3)]);
    assert_eq!(texts(&page.entries), ["new"]);
    assert_eq!(page.entries.len(), 1);
    assert!(!page.has_more);
}

#[tokio::test]
async fn cached_parts_beyond_stale_total_are_read_without_skipping_gaps() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let _lease = store.open_thread("user", "thread").await.unwrap();
    store
        .append_parts(
            "user",
            "thread",
            &[
                prompt(0, "remote"),
                prompt(1, "local one"),
                prompt(2, "local two"),
                prompt(4, "after gap"),
            ],
        )
        .await
        .unwrap();
    let first = cached_page(&store, None, 1).await;
    assert_eq!(texts(&first.entries), ["remote", "local one", "local two"]);
    assert!(!first.has_more);
    let waiting = cached_page(&store, Some(&first.next_cursor), 1).await;
    assert!(waiting.entries.is_empty());
    assert_eq!(waiting.next_cursor, first.next_cursor);
    assert!(!waiting.has_more);
    store
        .append_parts("user", "thread", &[prompt(3, "gap filled")])
        .await
        .unwrap();
    let next = cached_page(&store, Some(&waiting.next_cursor), 1).await;
    assert_eq!(texts(&next.entries), ["gap filled", "after gap"]);
    assert!(!next.has_more);
}

#[tokio::test]
async fn unicode_fragments_resume_without_loss_and_cursor_survives_a_new_store() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let _lease = store.open_thread("user", "thread").await.unwrap();
    let text = "aé🦀".repeat(12_000);
    store
        .append_parts(
            "user",
            "thread",
            &[
                prompt(0, &text),
                completion(1, vec![json!({"type": "text", "text": text})]),
                prompt(2, "tail"),
            ],
        )
        .await
        .unwrap();
    let (fragments, cursor) = collect_pages(&store, None, 3, 8_000).await;
    let mut prompt_text = String::new();
    let mut reply_text = String::new();
    for entry in &fragments {
        match entry {
            MonitorEntry::Prompt { id, text } if id == "prompt:prompt:0" => {
                prompt_text.push_str(text)
            }
            MonitorEntry::Text { id, text } if id == "text:completion:1:0" => {
                reply_text.push_str(text)
            }
            MonitorEntry::Prompt { text, .. } => assert_eq!(text, "tail"),
            other => panic!("unexpected fragment: {other:?}"),
        }
    }
    assert_eq!(prompt_text, text);
    assert_eq!(reply_text, text);
    assert_eq!(texts(&fragments).last(), Some(&"tail"));
    drop(_lease);
    drop(store);
    let reopened = TranscriptStore::new(dir.path().to_owned());
    let _lease = reopened.open_thread("user", "thread").await.unwrap();
    reopened
        .append_parts("user", "thread", &[prompt(3, "new")])
        .await
        .unwrap();
    let next = local_page(&reopened, Some(&cursor), 4, 8_000).await;
    assert_eq!(texts(&next.entries), ["new"]);
    assert!(!next.has_more);
}

#[tokio::test]
async fn late_patch_result_blocks_later_text_and_matches_run_and_invocation() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let _lease = store.open_thread("user", "thread").await.unwrap();
    store
        .append_parts(
            "user",
            "thread",
            &[
                completion(
                    0,
                    vec![json!({"type": "text", "text": "before"}), patch_call("inv")],
                ),
                result(1, "other-run", "inv", "completed"),
                result(2, "run", "other-invocation", "completed"),
                result(3, "run", "inv", "started"),
                completion(4, vec![json!({"type": "text", "text": "after"})]),
            ],
        )
        .await
        .unwrap();
    let first = local_page(&store, None, 5, 1_000).await;
    assert_eq!(texts(&first.entries), ["before"]);
    assert!(!first.has_more);
    let pending = local_page(&store, Some(&first.next_cursor), 5, 1_000).await;
    assert!(pending.entries.is_empty());
    assert_eq!(first.next_cursor, pending.next_cursor);
    store
        .append_parts("user", "thread", &[result(5, "run", "inv", "completed")])
        .await
        .unwrap();
    let settled = cached_page(&store, Some(&pending.next_cursor), 5).await;
    assert!(matches!(
        &settled.entries[0],
        MonitorEntry::Patch { id, ok: true, changes }
            if id == "patch:completion:0:1" && changes[0].path == "src/main.rs"
    ));
    assert_eq!(texts(&settled.entries), ["after"]);
    assert_eq!(settled.entries.len(), 2);
    assert!(!settled.has_more);
}

#[tokio::test]
async fn reused_call_ids_pair_by_invocation_even_when_results_arrive_in_reverse_order() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let _lease = store.open_thread("user", "thread").await.unwrap();
    store
        .append_parts(
            "user",
            "thread",
            &[
                completion(0, vec![patch_call("first"), patch_call("second")]),
                result(1, "run", "second", "cancelled"),
                result(2, "run", "first", "completed"),
            ],
        )
        .await
        .unwrap();
    let page = cached_page(&store, None, 3).await;
    assert!(matches!(
        &page.entries[0],
        MonitorEntry::Patch { id, ok: true, .. } if id == "patch:completion:0:0"
    ));
    assert!(matches!(
        &page.entries[1],
        MonitorEntry::Patch { id, ok: false, .. } if id == "patch:completion:0:1"
    ));
    assert_eq!(page.entries.len(), 2);
    assert!(!page.has_more);
}

#[tokio::test]
async fn historical_orphan_patches_and_normalized_calls_are_reported_once() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let _lease = store.open_thread("user", "thread").await.unwrap();
    let legacy_result = |number, invocation: Option<&str>, call_id, status| {
        let mut part = result(number, "run", "unused", status);
        let tool = part.tool.as_mut().unwrap();
        tool.name = "apply_patch".into();
        tool.call_id = call_id;
        tool.tool_invocation_id = invocation.map(str::to_owned);
        part
    };
    let mapped_call: TranscriptPart = serde_json::from_value(json!({
        "number": 2,
        "sourceKey": "historical-completion",
        "kind": "completion",
        "runId": "run",
        "completion": {"items": [{"type": "tool-call", "name": "apply_patch", "callId": "mapped"}]},
        "work": {"toolInvocations": [{"item": 0, "toolInvocationId": "mapped-invocation"}]}
    }))
    .unwrap();
    let mut unrelated = legacy_result(3, None, "mapped".into(), "failed");
    unrelated.tool.as_mut().unwrap().name = "exec_cmd".into();
    let unmapped_call = completion(
        5,
        vec![json!({"type": "tool-call", "name": "apply_patch", "callId": "unmapped"})],
    );
    store
        .append_parts(
            "user",
            "thread",
            &[
                legacy_result(0, None, "executor-job:orphan".into(), "started"),
                legacy_result(1, None, "executor-job:orphan".into(), "completed"),
                mapped_call,
                unrelated,
                legacy_result(4, Some("mapped-invocation"), "mapped".into(), "completed"),
                unmapped_call,
                legacy_result(6, None, "unmapped".into(), "completed"),
                prompt(7, "tail"),
            ],
        )
        .await
        .unwrap();
    let page = cached_page(&store, None, 8).await;
    let ids: Vec<_> = page
        .entries
        .iter()
        .filter_map(|entry| match entry {
            MonitorEntry::Patch { id, ok, .. } => {
                assert!(ok);
                Some(id.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        ids,
        [
            "patch:result:1",
            "patch:historical-completion:0",
            "patch:completion:5:0"
        ]
    );
    assert_eq!(texts(&page.entries), ["tail"]);
    assert!(!page.has_more);
    let next = cached_page(&store, Some(&page.next_cursor), 8).await;
    assert!(next.entries.is_empty());
}

#[tokio::test]
async fn patch_lists_page_without_losing_changes_or_following_text() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let _lease = store.open_thread("user", "thread").await.unwrap();
    let mut patch_result = result(1, "run", "inv", "completed");
    let changes: Vec<_> = (0..300)
        .map(|number| {
            json!({
                "operation": "renamed",
                "path": format!("新/{number}"),
                "source": format!("old/{number}")
            })
        })
        .collect();
    patch_result.tool.as_mut().unwrap().output = Some(json!({"changes": changes}));
    store
        .append_parts(
            "user",
            "thread",
            &[
                completion(
                    0,
                    vec![patch_call("inv"), json!({"type": "text", "text": "done"})],
                ),
                patch_result,
            ],
        )
        .await
        .unwrap();
    let mut collected = Vec::new();
    let mut replies = Vec::new();
    let (entries, _) = collect_pages(&store, None, 2, 500).await;
    for entry in entries {
        match entry {
            MonitorEntry::Patch { id, ok, changes } => {
                assert_eq!(id, "patch:completion:0:0");
                assert!(ok);
                assert!(!changes.is_empty());
                collected.extend(changes);
            }
            MonitorEntry::Text { text, .. } => replies.push(text),
            other => panic!("unexpected entry: {other:?}"),
        }
    }
    assert_eq!(
        collected,
        (0..300)
            .map(|number| PatchChangeSummary {
                operation: "renamed".into(),
                path: format!("新/{number}"),
                source_path: Some(format!("old/{number}")),
            })
            .collect::<Vec<_>>()
    );
    assert_eq!(replies, ["done"]);
}

#[tokio::test]
async fn hidden_parts_and_filtered_runs_advance_permanently() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let _lease = store.open_thread("user", "thread").await.unwrap();
    let mut hidden = prompt(0, "instructions");
    hidden.prompt.as_mut().unwrap().hidden = Some(crate::HiddenPromptKind::Instructions);
    let mut other_run = completion(2, vec![patch_call("pending-in-another-run")]);
    other_run.run_id = "other".into();
    store
        .append_parts(
            "user",
            "thread",
            &[
                hidden,
                prompt(1, "sender's prompt"),
                other_run,
                completion(3, vec![json!({"type": "reasoning", "text": "private"})]),
                result(4, "run", "inv", "started"),
                completion(5, vec![json!({"type": "text", "text": "visible"})]),
            ],
        )
        .await
        .unwrap();
    let page = download_monitor_page(
        &store,
        "user",
        "thread",
        None,
        6,
        &MonitorFilter {
            only_run_id: Some("run".into()),
            hidden_prompt_runs: BTreeSet::from(["run".into()]),
        },
        |_, _| async { anyhow::bail!("all parts are local") },
    )
    .await
    .unwrap();
    assert_eq!(texts(&page.entries), ["visible"]);
    assert!(!page.has_more);
    let next = local_page(&store, Some(&page.next_cursor), 6, 1_000).await;
    assert!(next.entries.is_empty());
    assert!(!next.has_more);
}

#[tokio::test]
async fn failed_and_cancelled_patches_report_failure_without_changes() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let _lease = store.open_thread("user", "thread").await.unwrap();
    store
        .append_parts(
            "user",
            "thread",
            &[
                completion(0, vec![patch_call("failed"), patch_call("cancelled")]),
                result(1, "run", "failed", "failed"),
                result(2, "run", "cancelled", "cancelled"),
            ],
        )
        .await
        .unwrap();
    let page = local_page(&store, None, 3, 1_000).await;
    assert_eq!(page.entries.len(), 2);
    assert!(page.entries.iter().all(|entry| matches!(
        entry,
        MonitorEntry::Patch { ok: false, changes, .. } if changes.is_empty()
    )));
}

#[test]
fn malformed_and_foreign_cursors_fail_explicitly() {
    let malformed = MonitorCursor::read("thread", Some("!!!"))
        .unwrap_err()
        .downcast::<MonitorReadError>()
        .unwrap();
    assert_eq!(malformed, MonitorReadError::MalformedCursor);
    let encoded = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&MonitorCursor {
            thread_id: "other".into(),
            ..MonitorCursor::default()
        })
        .unwrap(),
    );
    let foreign = MonitorCursor::read("thread", Some(&encoded))
        .unwrap_err()
        .downcast::<MonitorReadError>()
        .unwrap();
    assert_eq!(foreign, MonitorReadError::WrongThread);
}
