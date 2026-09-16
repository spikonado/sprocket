use super::*;

#[derive(Default)]
pub(super) struct Metadata {
    previous: BTreeMap<Feed, FunctionResult>,
    complete: Option<bool>,
}

pub(super) struct Update {
    pub state: WorkState,
    pub snapshot: WorkSnapshot,
    pub add: Vec<Feed>,
    pub remove: Vec<Feed>,
}

impl Metadata {
    pub fn apply(
        &mut self,
        results: BTreeMap<Feed, Option<FunctionResult>>,
    ) -> anyhow::Result<Option<Update>> {
        let Some(Some(result)) = results.get(&Feed::State) else {
            return Ok(None);
        };
        let state: WorkState =
            decode_labeled_function_result(result.clone(), "transcriptSections:state")?;
        let mut snapshot = WorkSnapshot {
            through: state.through,
            total: state.total_parts,
            complete: true,
            active_run_id: state.active_run_id.clone(),
            sections: Vec::new(),
            memberships: Vec::new(),
            membership_pages: Vec::new(),
        };
        let mut add = Vec::new();
        let mut remove = Vec::new();
        let mut changed = false;
        for (feed, result) in results {
            let Some(result) = result else {
                if !matches!(feed, Feed::Memberships(_)) {
                    snapshot.complete = false;
                }
                continue;
            };
            if self.previous.get(&feed) == Some(&result) {
                continue;
            }
            changed = true;
            match &feed {
                Feed::State => {}
                Feed::Sections { after, before } => {
                    let page: SectionPage = decode_labeled_function_result(
                        result.clone(),
                        "transcriptSections:sections",
                    )?;
                    if let Some(split) = page.split {
                        snapshot.complete = false;
                        remove.push(feed.clone());
                        add.push(Feed::Sections {
                            after: after.clone(),
                            before: Some(split.clone()),
                        });
                        add.push(Feed::Sections {
                            after: split,
                            before: before.clone(),
                        });
                        continue;
                    }
                    snapshot.sections.push(SectionPartition {
                        after: after.clone(),
                        before: before.clone(),
                        sections: page.rows,
                    });
                }
                Feed::Memberships(start) => {
                    let parts: Vec<MembershipPart> = decode_labeled_function_result(
                        result.clone(),
                        "transcriptSections:memberships",
                    )?;
                    snapshot
                        .memberships
                        .extend(parts.into_iter().filter_map(|part| {
                            part.work.map(|work| WorkMembership {
                                number: part.number,
                                processed: work.processed,
                                ranges: work.ranges,
                                section_key: work.section_key,
                            })
                        }));
                    snapshot.membership_pages.push(*start);
                    remove.push(feed.clone());
                }
            }
            self.previous.insert(feed, result);
        }
        if !changed && self.complete == Some(snapshot.complete) {
            return Ok(None);
        }
        self.complete = Some(snapshot.complete);
        for feed in &remove {
            self.previous.remove(feed);
        }
        Ok(Some(Update {
            state,
            snapshot,
            add,
            remove,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value as Json, json};
    use sprocket_agent::WorkReplica;

    fn value(value: Json) -> Option<FunctionResult> {
        Some(FunctionResult::Value(Value::try_from(value).unwrap()))
    }

    fn state() -> Option<FunctionResult> {
        value(json!({"totalParts":20,"through":{"part":20,"item":0},"historyFromNumber":0}))
    }

    fn sections(after: &str, before: Option<&str>) -> Feed {
        Feed::Sections {
            after: after.into(),
            before: before.map(str::to_owned),
        }
    }

    fn membership(start: u32, end: u32) -> Option<FunctionResult> {
        value(json!(
            (start..end)
                .map(|number| json!({"number":number,"work":{"processed":1,"ranges":[]}}))
                .collect::<Vec<_>>()
        ))
    }

    #[test]
    fn raw_downloads_and_membership_subscriptions_can_arrive_in_either_order() {
        for raw_first in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
            let parts: Vec<sprocket_agent::TranscriptPart> = (0..20).map(|number| serde_json::from_value(json!({
                "number":number,"sourceKey":format!("completion:run:{number}"),"kind":"completion","runId":"run",
                "completion":{"streamId":number.to_string(),"items":[{"type":"text","text":number.to_string()}]}
            })).unwrap()).collect();
            let mut metadata = Metadata::default();
            if raw_first {
                replica.save_parts("thread", &parts).unwrap();
            }
            let update = metadata
                .apply(BTreeMap::from([
                    (Feed::State, state()),
                    (sections("", None), value(json!({"rows":[],"split":null}))),
                ]))
                .unwrap()
                .unwrap();
            replica.save_snapshot("thread", update.snapshot).unwrap();
            assert_eq!(replica.pending_membership_pages(4).unwrap(), vec![16, 8, 0]);
            for (start, end) in [(16, 20), (8, 16), (0, 8)] {
                let update = metadata
                    .apply(BTreeMap::from([
                        (Feed::State, state()),
                        (sections("", None), value(json!({"rows":[],"split":null}))),
                        (Feed::Memberships(start), membership(start, end)),
                    ]))
                    .unwrap()
                    .unwrap();
                assert!(
                    matches!(update.remove.as_slice(), [Feed::Memberships(number)] if *number == start)
                );
                replica.save_snapshot("thread", update.snapshot).unwrap();
                if start == 16 {
                    if !raw_first {
                        replica.save_parts("thread", &parts).unwrap();
                    }
                    let page = replica.page(None, 12, None, &[], false).unwrap();
                    assert_eq!(page["nextBefore"], 16 * 16_384);
                    assert_eq!(
                        replica
                            .page(page["nextBefore"].as_u64(), 40, None, &[], false)
                            .unwrap()["indexing"],
                        true
                    );
                }
            }
            assert!(replica.pending_membership_pages(4).unwrap().is_empty());
            assert_eq!(
                replica.page(None, 40, None, &[], false).unwrap()["rows"]
                    .as_array()
                    .unwrap()
                    .len(),
                20
            );
        }
    }

    #[test]
    fn partial_checkpoint_and_reconnect_preserve_pending_handoffs() {
        let dir = tempfile::tempdir().unwrap();
        let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
        let part = serde_json::from_value(json!({
            "number":0,"sourceKey":"completion:run:stream","kind":"completion","runId":"run",
            "completion":{"streamId":"stream","items":[
                {"type":"text","text":"First"}, {"type":"text","text":"Second"}
            ]}
        }))
        .unwrap();
        replica.save_parts("thread", &[part]).unwrap();
        let streams = [("run".into(), "stream".into())];
        let mut metadata = Metadata::default();
        let partial_state =
            value(json!({"totalParts":1,"through":{"part":0,"item":1},"historyFromNumber":0}));
        let section_page = value(json!({"rows":[],"split":null}));
        let update = metadata
            .apply(BTreeMap::from([
                (Feed::State, partial_state),
                (sections("", None), section_page.clone()),
                (Feed::Memberships(0), membership(0, 1)),
            ]))
            .unwrap()
            .unwrap();
        replica.save_snapshot("thread", update.snapshot).unwrap();
        assert_eq!(
            replica.page(None, 12, None, &streams, false).unwrap()["indexing"],
            true
        );
        let complete_state =
            value(json!({"totalParts":1,"through":{"part":1,"item":0},"historyFromNumber":0}));
        let update = metadata
            .apply(BTreeMap::from([
                (Feed::State, complete_state.clone()),
                (sections("", None), section_page.clone()),
            ]))
            .unwrap()
            .unwrap();
        replica.save_snapshot("thread", update.snapshot).unwrap();
        drop(replica);

        let mut replica = WorkReplica::open(dir.path().to_owned()).unwrap();
        let mut metadata = Metadata::default();
        assert_eq!(replica.pending_membership_pages(4).unwrap(), vec![0]);
        let offline = replica.page(None, 12, None, &streams, true).unwrap();
        assert_eq!(offline["indexing"], true);
        assert_eq!(offline["persistedStreams"], json!([]));
        let update = metadata
            .apply(BTreeMap::from([
                (Feed::State, complete_state.clone()),
                (sections("", None), None),
            ]))
            .unwrap()
            .unwrap();
        assert!(!update.snapshot.complete);
        replica.save_snapshot("thread", update.snapshot).unwrap();
        let update = metadata
            .apply(BTreeMap::from([
                (Feed::State, complete_state),
                (sections("", None), section_page),
                (
                    Feed::Memberships(0),
                    value(json!([{"number":0,"work":{"processed":2,"ranges":[]}}])),
                ),
            ]))
            .unwrap()
            .unwrap();
        replica.save_snapshot("thread", update.snapshot).unwrap();
        let page = replica.page(None, 12, None, &streams, false).unwrap();
        assert_eq!(page["indexing"], false);
        assert_eq!(page["rows"].as_array().unwrap().len(), 2);
        assert_eq!(
            page["persistedStreams"],
            json!([{"runId":"run","streamId":"stream"}])
        );
    }

    #[test]
    fn split_subscriptions_do_not_complete_until_both_replacements_arrive() {
        let mut metadata = Metadata::default();
        let split = metadata
            .apply(BTreeMap::from([
                (Feed::State, state()),
                (
                    sections("", None),
                    value(json!({"rows":[],"split":"work-9-0"})),
                ),
            ]))
            .unwrap()
            .unwrap();
        assert!(!split.snapshot.complete);
        assert_eq!(split.add.len(), 2);
        let partial = metadata
            .apply(BTreeMap::from([
                (Feed::State, state()),
                (
                    sections("", Some("work-9-0")),
                    value(json!({"rows":[],"split":null})),
                ),
                (sections("work-9-0", None), None),
            ]))
            .unwrap()
            .unwrap();
        assert!(!partial.snapshot.complete);
        let completed = metadata
            .apply(BTreeMap::from([
                (Feed::State, state()),
                (
                    sections("", Some("work-9-0")),
                    value(json!({"rows":[],"split":null})),
                ),
                (
                    sections("work-9-0", None),
                    value(json!({"rows":[],"split":null})),
                ),
            ]))
            .unwrap()
            .unwrap();
        assert!(completed.snapshot.complete);
        assert_eq!(completed.snapshot.sections.len(), 1);
    }
}
