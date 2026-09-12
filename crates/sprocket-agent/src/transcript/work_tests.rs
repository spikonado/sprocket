use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::TranscriptPart;

#[tokio::test]
async fn work_replica_rejects_unsafe_path_components_before_creating_files() {
    let root = tempfile::tempdir().unwrap();
    let store = super::TranscriptStore::new(root.path().join("replica"));
    for invalid in [
        "",
        ".",
        "..",
        "../other",
        "/absolute",
        "a/b",
        "a\\b",
        "C:\\other",
        "C:other",
        "name.ext",
        "name ",
        "nul\0byte",
        "a\nb",
        "a%2fb",
    ] {
        for (user, thread) in [(invalid, "thread"), ("user", invalid)] {
            assert!(
                store
                    .with_work_replica(user, thread, |_| Ok(()))
                    .await
                    .is_err()
            );
        }
    }
    assert!(!store.root().exists());
}

#[tokio::test]
async fn work_replica_is_scoped_to_the_thread_and_cleared_with_it() {
    let root = tempfile::tempdir().unwrap();
    let store = super::TranscriptStore::new(root.path().to_owned());
    store
        .with_work_replica("user", "thread", |replica| {
            replica.save_parts("thread", &[completion(0, vec![reasoning("stored")])])
        })
        .await
        .unwrap();
    assert!(
        !store
            .with_work_replica("other", "thread", |replica| replica.has_part(0))
            .await
            .unwrap()
    );
    assert!(
        !store
            .with_work_replica("user", "other", |replica| replica.has_part(0))
            .await
            .unwrap()
    );
    assert!(
        store
            .with_work_replica("user", "thread", |replica| replica.has_part(0))
            .await
            .unwrap()
    );
    store.clear_thread("user", "thread").await.unwrap();
    assert!(
        !store
            .with_work_replica("user", "thread", |replica| replica.has_part(0))
            .await
            .unwrap()
    );
}
use super::replica::{SectionPartition, WorkReplica, WorkSnapshot};
use super::sections::{WorkBatch, WorkMembership, WorkPosition, WorkSection};

fn completion(number: u32, items: Vec<Value>) -> TranscriptPart {
    serde_json::from_value(json!({
        "number":number,"sourceKey":format!("completion:run:stream-{number}"),"kind":"completion","runId":"run",
        "completion":{"streamId":format!("stream-{number}"),"items":items}
    })).unwrap()
}

fn tool(number: u32, call: &str, name: &str, status: &str, output: Value) -> TranscriptPart {
    serde_json::from_value(json!({
        "number":number,"sourceKey":format!("tool:{number}"),"kind":"tool","runId":"run","createdAt":1000+number,
        "tool":{"callId":call,"name":name,"status":status,"output":output}
    })).unwrap()
}

fn reasoning(text: &str) -> Value {
    json!({"type":"reasoning","text":text,"startedAt":100,"completedAt":200,"providerMetadata":{"secret":"ciphertext"}})
}

#[derive(Default)]
struct Cloud {
    through: WorkPosition,
    sections: BTreeMap<String, WorkSection>,
    memberships: BTreeMap<u32, WorkMembership>,
}

impl Cloud {
    fn apply(&mut self, batch: &WorkBatch) {
        assert_eq!(batch.expected, self.through);
        for section in &batch.sections {
            self.sections.insert(section.key.clone(), section.clone());
        }
        for key in &batch.removed {
            self.sections.remove(key);
        }
        for membership in &batch.memberships {
            self.memberships
                .insert(membership.number, membership.clone());
        }
        self.through = batch.through;
    }

    fn process(&mut self, replica: &mut WorkReplica) {
        while let Some(batch) = replica.advance(self.through).unwrap() {
            self.apply(&batch);
            replica.acknowledge_batch(batch.through).unwrap();
        }
    }

    fn snapshot(&self, total: u32) -> WorkSnapshot {
        WorkSnapshot {
            through: self.through,
            total,
            complete: true,
            active_run_id: None,
            sections: vec![SectionPartition {
                after: String::new(),
                before: None,
                sections: self.sections.values().cloned().collect(),
            }],
            memberships: self.memberships.values().cloned().collect(),
            membership_pages: (0..total).step_by(8).collect(),
        }
    }
}

#[test]
fn late_tool_result_does_not_extend_a_section_across_visible_text() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    let parts = [
        completion(
            0,
            vec![
                reasoning("first"),
                json!({"type":"tool-call","callId":"call","name":"read","input":{}}),
                json!({"type":"text","text":"Visible answer"}),
                reasoning("second"),
            ],
        ),
        tool(1, "call", "read", "completed", json!({"contents":"result"})),
    ];
    replica.save_parts("thread", &parts).unwrap();
    let mut cloud = Cloud::default();
    cloud.process(&mut replica);
    assert_eq!(cloud.sections.len(), 2);
    assert_eq!(
        cloud.sections["work-0-0"].end,
        WorkPosition { part: 0, item: 2 }
    );
    assert_eq!(cloud.sections["work-0-0"].pending_tools, 0);
    assert_eq!(cloud.sections["work-0-0"].item_count, 2);
    assert_eq!(
        cloud.memberships[&1].section_key.as_deref(),
        Some("work-0-0")
    );
    replica.save_snapshot("thread", cloud.snapshot(2)).unwrap();
    let page = replica.page(None, 12, None, &[], false).unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 3);
    assert_eq!(page["rows"][1]["text"], "Visible answer");
    assert!(!page.to_string().contains("ciphertext"));
    assert!(!page.to_string().contains("result"));
    let detail = replica
        .details("work-0-0", None, None, false, 5, false)
        .unwrap();
    assert_eq!(detail["parts"][2]["output"]["contents"], "result");
    assert!(!detail.to_string().contains("ciphertext"));
}

#[test]
fn an_early_result_moves_to_its_canonical_call_without_losing_links() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    let mut cloud = Cloud::default();
    replica
        .save_parts(
            "thread",
            &[
                tool(0, "call", "read", "started", Value::Null),
                tool(1, "call", "read", "completed", json!({"value":7})),
            ],
        )
        .unwrap();
    cloud.process(&mut replica);
    assert!(cloud.sections["work-0-0"].provisional);
    replica.save_parts("thread",&[completion(2,vec![json!({"type":"text","text":"Before"}),json!({"type":"tool-call","callId":"call","name":"read","input":{"path":"file"}})])]).unwrap();
    cloud.process(&mut replica);
    assert!(!cloud.sections.contains_key("work-0-0"));
    assert_eq!(cloud.sections["work-2-1"].item_count, 1);
    assert_eq!(
        cloud.memberships[&0].section_key.as_deref(),
        Some("work-2-1")
    );
    assert_eq!(
        cloud.memberships[&1].section_key.as_deref(),
        Some("work-2-1")
    );
    replica.save_snapshot("thread", cloud.snapshot(3)).unwrap();
    let detail = replica
        .details("work-2-1", None, None, false, 5, false)
        .unwrap();
    assert_eq!(detail["parts"].as_array().unwrap().len(), 2);
    assert_eq!(detail["parts"][0]["input"]["path"], "file");
    assert_eq!(detail["parts"][0]["startedAt"], 1000.0);
}

#[test]
fn restart_retries_the_outbox_then_continues_at_the_item_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    replica
        .save_parts(
            "thread",
            &[completion(
                0,
                vec![
                    json!({"type":"tool-call","callId":"call","name":"read","input":{}}),
                    reasoning("after"),
                ],
            )],
        )
        .unwrap();
    let pending = replica.advance(WorkPosition::default()).unwrap().unwrap();
    assert_eq!(pending.through, WorkPosition { part: 0, item: 1 });
    drop(replica);
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    assert_eq!(
        serde_json::to_value(replica.advance(pending.through).unwrap().unwrap()).unwrap(),
        serde_json::to_value(&pending).unwrap()
    );
    replica.acknowledge_batch(pending.through).unwrap();
    let next = replica.advance(pending.through).unwrap().unwrap();
    assert_eq!(next.expected, pending.through);
    assert_eq!(next.sections[0].item_count, 2);
    assert_eq!(next.through, WorkPosition { part: 1, item: 0 });
}

#[test]
fn recent_details_use_downloaded_membership_without_replaying_old_parts() {
    let writer_dir = tempfile::tempdir().unwrap();
    let mut writer = WorkReplica::open(writer_dir.path().to_owned()).unwrap();
    let parts = [
        completion(0, vec![reasoning("older")]),
        completion(
            1,
            vec![json!({"type":"text","text":"Answer"}), reasoning("recent")],
        ),
    ];
    writer.save_parts("thread", &parts).unwrap();
    let mut cloud = Cloud::default();
    cloud.process(&mut writer);
    let reader_dir = tempfile::tempdir().unwrap();
    let mut reader = WorkReplica::open(reader_dir.path().to_owned()).unwrap();
    reader.save_snapshot("thread", cloud.snapshot(2)).unwrap();
    reader.save_parts("thread", &parts[1..]).unwrap();
    assert_eq!(reader.through().unwrap(), WorkPosition::default());
    assert!(!reader.has_part(0).unwrap());
    let detail = reader
        .details("work-1-1", None, None, false, 5, true)
        .unwrap();
    assert_eq!(detail["indexing"], false);
    assert_eq!(detail["stale"], true);
    assert_eq!(detail["parts"][0]["text"], "recent");
    let page = reader
        .page(None, 12, None, &[("run".into(), "stream-1".into())], true)
        .unwrap();
    assert_eq!(page["indexing"], false);
    assert_eq!(page["persistedStreams"].as_array().unwrap().len(), 1);
}

#[test]
fn details_page_in_both_directions_and_survive_reopening_offline() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    replica
        .save_parts(
            "thread",
            &[completion(
                0,
                (0..13)
                    .map(|number| reasoning(&number.to_string()))
                    .collect(),
            )],
        )
        .unwrap();
    let mut cloud = Cloud::default();
    cloud.process(&mut replica);
    replica.save_snapshot("thread", cloud.snapshot(1)).unwrap();
    drop(replica);
    let replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    let first = replica
        .details("work-0-0", None, None, false, 5, true)
        .unwrap();
    assert_eq!(first["parts"].as_array().unwrap().len(), 5);
    assert_eq!(first["parts"][4]["text"], "4");
    let next = replica
        .details(
            "work-0-0",
            first["nextAfter"].as_u64(),
            None,
            false,
            5,
            true,
        )
        .unwrap();
    assert_eq!(next["parts"][0]["text"], "5");
    let latest = replica
        .details("work-0-0", None, None, true, 5, true)
        .unwrap();
    assert_eq!(latest["parts"][0]["text"], "8");
    let previous = replica
        .details(
            "work-0-0",
            None,
            latest["previousBefore"].as_u64(),
            false,
            5,
            true,
        )
        .unwrap();
    assert_eq!(previous["parts"][0]["text"], "3");
}

#[test]
fn saved_rows_remain_readable_offline_after_an_interrupted_metadata_split() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    replica
        .save_parts("thread", &[completion(0, vec![reasoning("saved")])])
        .unwrap();
    let mut cloud = Cloud::default();
    cloud.process(&mut replica);
    replica.save_snapshot("thread", cloud.snapshot(1)).unwrap();
    let mut partial = cloud.snapshot(1);
    partial.complete = false;
    partial.sections.clear();
    partial.memberships.clear();
    replica.save_snapshot("thread", partial).unwrap();
    drop(replica);
    let replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    assert_eq!(
        replica.page(None, 12, None, &[], false).unwrap()["indexing"],
        true
    );
    let saved = replica
        .page(None, 12, None, &[("run".into(), "stream-0".into())], true)
        .unwrap();
    assert_eq!(saved["indexing"], false);
    assert_eq!(saved["rows"][0]["id"], "work-0-0");
    assert!(saved["persistedStreams"].as_array().unwrap().is_empty());
    let details = replica
        .details("work-0-0", None, None, false, 5, true)
        .unwrap();
    assert_eq!(details["parts"][0]["text"], "saved");
    assert_eq!(details["stale"], true);
}

#[test]
fn polling_finishes_the_original_command_across_a_text_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    let parts = [
        completion(
            0,
            vec![json!({"type":"tool-call","callId":"exec","name":"exec_command","input":{}})],
        ),
        tool(
            1,
            "exec",
            "exec_command",
            "completed",
            json!({"sessionId":"session","running":true}),
        ),
        completion(
            2,
            vec![
                json!({"type":"text","text":"Still running"}),
                json!({"type":"tool-call","callId":"poll","name":"write_stdin","input":{"sessionId":"session"}}),
            ],
        ),
        tool(
            3,
            "poll",
            "write_stdin",
            "completed",
            json!({"running":false}),
        ),
    ];
    replica.save_parts("thread", &parts).unwrap();
    let mut cloud = Cloud::default();
    cloud.process(&mut replica);
    assert_eq!(cloud.sections["work-0-0"].pending_tools, 0);
    assert_eq!(
        cloud.sections["work-0-0"].end,
        WorkPosition { part: 0, item: 1 }
    );
    assert_eq!(cloud.sections["work-2-1"].pending_tools, 0);
    replica.save_snapshot("thread", cloud.snapshot(4)).unwrap();
    let detail = replica
        .details("work-0-0", None, None, false, 5, false)
        .unwrap();
    assert_eq!(detail["parts"][1]["output"]["running"], false);
    assert_eq!(detail["parts"][1]["completedAt"], 1003.0);
}

#[test]
fn a_terminal_run_closes_unanswered_tools_without_inventing_a_duration() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    replica.save_parts("thread",&[completion(0,vec![json!({"type":"tool-call","callId":"call","name":"read","input":{},"startedAt":100})])]).unwrap();
    let mut cloud = Cloud::default();
    cloud.process(&mut replica);
    assert!(
        replica
            .finish_inactive(Some("run"), cloud.through)
            .unwrap()
            .is_none()
    );
    let finish = replica
        .finish_inactive(None, cloud.through)
        .unwrap()
        .unwrap();
    assert_eq!(finish.finished_run_id.as_deref(), Some("run"));
    assert_eq!(finish.sections[0].pending_tools, 0);
    assert!(finish.sections[0].closed);
    assert_eq!(finish.sections[0].completed_at, None);
    replica.acknowledge_batch(finish.through).unwrap();
    assert!(
        replica
            .finish_inactive(None, cloud.through)
            .unwrap()
            .is_none()
    );
}

#[test]
fn a_failed_batch_rolls_back_items_and_checkpoint_together() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    let call = json!({"type":"tool-call","callId":"duplicate","name":"read","input":{}});
    replica
        .save_parts(
            "thread",
            &[completion(
                0,
                vec![call.clone(), reasoning("rolled back"), call],
            )],
        )
        .unwrap();
    let first = replica.advance(WorkPosition::default()).unwrap().unwrap();
    replica.acknowledge_batch(first.through).unwrap();
    assert!(replica.advance(first.through).is_err());
    assert_eq!(replica.through().unwrap(), first.through);
    assert!(replica.pending_batch().unwrap().is_none());
}

#[test]
fn the_change_cursor_finishes_a_large_local_transaction_without_replaying_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    replica
        .save_parts(
            "thread",
            &[completion(
                0,
                (0..70)
                    .map(|number| json!({"type":"text","text":number.to_string()}))
                    .collect(),
            )],
        )
        .unwrap();
    let mut cloud = Cloud::default();
    cloud.process(&mut replica);
    replica.save_snapshot("thread", cloud.snapshot(1)).unwrap();
    let first = replica.page(None, 12, Some((0, -1)), &[], false).unwrap();
    assert_eq!(first["changes"].as_array().unwrap().len(), 64);
    assert_eq!(first["moreChanges"], true);
    let cursor = &first["changesCursor"];
    let next = replica
        .page(
            None,
            12,
            Some((
                cursor["revision"].as_u64().unwrap(),
                cursor["sequence"].as_i64().unwrap(),
            )),
            &[],
            false,
        )
        .unwrap();
    assert_eq!(next["changes"].as_array().unwrap().len(), 6);
    assert_eq!(next["moreChanges"], false);
    let cursor = &next["changesCursor"];
    let done = replica
        .page(
            None,
            12,
            Some((
                cursor["revision"].as_u64().unwrap(),
                cursor["sequence"].as_i64().unwrap(),
            )),
            &[],
            false,
        )
        .unwrap();
    assert!(done["changes"].as_array().unwrap().is_empty());
}

#[test]
fn downloading_a_result_refreshes_a_previously_downloaded_section_summary() {
    let writer_dir = tempfile::tempdir().unwrap();
    let mut writer = WorkReplica::open(writer_dir.path().to_owned()).unwrap();
    let parts = [
        completion(
            0,
            vec![json!({"type":"tool-call","callId":"call","name":"read","input":{}})],
        ),
        tool(1, "call", "read", "completed", json!({"text":"result"})),
    ];
    writer.save_parts("thread", &parts).unwrap();
    let mut cloud = Cloud::default();
    cloud.process(&mut writer);
    let dir = tempfile::tempdir().unwrap();
    let mut reader = WorkReplica::open(dir.path().to_owned()).unwrap();
    reader.save_snapshot("thread", cloud.snapshot(2)).unwrap();
    reader.save_parts("thread", &parts[..1]).unwrap();
    let before = reader.page(None, 12, None, &[], false).unwrap();
    reader.save_parts("thread", &parts[1..]).unwrap();
    let after = reader.page(None, 12, None, &[], false).unwrap();
    assert!(
        after["rows"][0]["revision"].as_i64().unwrap()
            > before["rows"][0]["revision"].as_i64().unwrap()
    );
    let details = reader
        .details("work-0-0", None, None, false, 5, false)
        .unwrap();
    assert_eq!(details["parts"][1]["output"]["text"], "result");
}

#[test]
fn canonical_tool_timing_does_not_report_a_negative_duration() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    replica.save_parts("thread",&[
        tool(0,"call","read","started",Value::Null),
        tool(1,"call","read","completed",json!({"text":"result"})),
        completion(2,vec![json!({"type":"tool-call","callId":"call","name":"read","input":{},"startedAt":1200})]),
    ]).unwrap();
    let mut cloud = Cloud::default();
    cloud.process(&mut replica);
    assert_eq!(cloud.sections["work-2-0"].started_at, Some(1200.0));
    assert_eq!(cloud.sections["work-2-0"].completed_at, None);
    replica.save_snapshot("thread", cloud.snapshot(3)).unwrap();
    let details = replica
        .details("work-2-0", None, None, false, 5, false)
        .unwrap();
    assert_eq!(details["parts"][0]["startedAt"], 1200.0);
    assert!(details["parts"][1]["completedAt"].is_null());
}

#[test]
fn membership_refresh_resumes_newest_first_and_revisits_relocated_results() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    replica
        .save_parts(
            "thread",
            &[tool(0, "call", "read", "completed", json!({"value":7}))],
        )
        .unwrap();
    let mut cloud = Cloud::default();
    cloud.process(&mut replica);
    replica.save_snapshot("thread", cloud.snapshot(1)).unwrap();
    assert!(replica.pending_membership_pages(4).unwrap().is_empty());

    let mut snapshot = cloud.snapshot(100_000);
    snapshot.through = WorkPosition {
        part: 100_000,
        item: 0,
    };
    snapshot.memberships.clear();
    snapshot.membership_pages.clear();
    replica.save_snapshot("thread", snapshot).unwrap();
    assert_eq!(
        replica.pending_membership_pages(4).unwrap(),
        vec![99_992, 99_984, 99_976, 99_968]
    );
    drop(replica);
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    let mut snapshot = cloud.snapshot(100_000);
    snapshot.through = WorkPosition {
        part: 100_000,
        item: 0,
    };
    snapshot.membership_pages = (0..100_000).step_by(8).collect();
    replica.save_snapshot("thread", snapshot).unwrap();
    assert!(replica.pending_membership_pages(4).unwrap().is_empty());

    let mut snapshot = cloud.snapshot(100_000);
    snapshot.through = WorkPosition {
        part: 100_000,
        item: 0,
    };
    snapshot.sections[0].sections.clear();
    snapshot.memberships.clear();
    snapshot.membership_pages.clear();
    replica.save_snapshot("thread", snapshot).unwrap();
    assert_eq!(replica.pending_membership_pages(4).unwrap(), vec![0]);
    drop(replica);
    let replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    assert_eq!(replica.pending_membership_pages(4).unwrap(), vec![0]);
}

#[test]
fn partial_checkpoint_refreshes_the_current_membership_page() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    let cloud = Cloud::default();
    for item in [1, 2] {
        let mut snapshot = cloud.snapshot(1);
        snapshot.through = WorkPosition { part: 0, item };
        snapshot.membership_pages.clear();
        replica.save_snapshot("thread", snapshot).unwrap();
        assert_eq!(replica.pending_membership_pages(4).unwrap(), vec![0]);
        let mut snapshot = cloud.snapshot(1);
        snapshot.through = WorkPosition { part: 0, item };
        replica.save_snapshot("thread", snapshot).unwrap();
        assert!(replica.pending_membership_pages(4).unwrap().is_empty());
    }
}

#[test]
fn completed_detail_pages_do_not_retry_empty_ends_or_missing_sections() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    replica
        .save_parts(
            "thread",
            &[completion(
                0,
                vec![
                    reasoning("first"),
                    json!({"type":"tool-call","callId":"hidden","name":"add_artifact","input":{}}),
                    reasoning("last"),
                ],
            )],
        )
        .unwrap();
    let mut cloud = Cloud::default();
    cloud.process(&mut replica);
    replica.save_snapshot("thread", cloud.snapshot(1)).unwrap();
    let page = replica
        .details("work-0-0", None, None, false, 5, false)
        .unwrap();
    assert_eq!(page["parts"].as_array().unwrap().len(), 2);
    assert!(page.get("nextAfter").is_none());
    assert!(page.get("previousBefore").is_none());
    for (section, after) in [("work-0-0", Some(4)), ("work-99-0", None)] {
        let empty = replica
            .details(section, after, None, false, 5, true)
            .unwrap();
        assert_eq!(empty["indexing"], false);
        assert!(empty["parts"].as_array().unwrap().is_empty());
    }
}

#[test]
fn conflicting_raw_identity_rolls_back_the_entire_download_batch() {
    let dir = tempfile::tempdir().unwrap();
    let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    let original = completion(0, vec![reasoning("original")]);
    replica.save_parts("thread", &[original.clone()]).unwrap();
    replica.save_parts("thread", &[original.clone()]).unwrap();
    assert!(
        replica
            .save_parts(
                "thread",
                &[
                    completion(1, vec![reasoning("new")]),
                    completion(0, vec![reasoning("changed")]),
                ]
            )
            .is_err()
    );
    assert!(!replica.has_part(1).unwrap());
    let mut reused = original;
    reused.number = 2;
    assert!(replica.save_parts("thread", &[reused]).is_err());
    assert!(!replica.has_part(2).unwrap());
}

#[tokio::test]
async fn corrupt_sqlite_is_preserved_without_losing_jsonl_bodies() {
    let dir = tempfile::tempdir().unwrap();
    let store = super::TranscriptStore::new(dir.path().to_owned());
    let part = completion(0, vec![reasoning("retained")]);
    store.append_parts("user", "thread", &[part]).await.unwrap();
    store.prepare_work_replica("user", "thread").await.unwrap();
    let before = store
        .with_work_replica("user", "thread", |replica| {
            replica.page(None, 12, None, &[], true)
        })
        .await
        .unwrap();
    let replica_path = store
        .display_cache_path("user", "thread", "replica")
        .unwrap();
    std::fs::write(replica_path.join("history.sqlite3"), b"not a database").unwrap();
    assert!(
        store
            .with_work_replica("user", "thread", |_| Ok(()))
            .await
            .is_err()
    );
    store.prepare_work_replica("user", "thread").await.unwrap();
    let after = store
        .with_work_replica("user", "thread", |replica| {
            replica.page(None, 12, None, &[], true)
        })
        .await
        .unwrap();
    assert_ne!(before["replicaId"], after["replicaId"]);
    let retained = store.read_parts("user", "thread", &[0]).await.unwrap();
    assert_eq!(retained.len(), 1);
    assert!(
        std::fs::read_dir(replica_path.parent().unwrap())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("replica-corrupt-"))
    );
}
