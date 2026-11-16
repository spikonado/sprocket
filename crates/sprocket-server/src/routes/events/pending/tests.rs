use super::*;

#[tokio::test]
async fn workspace_snapshots_replace_old_file_copies_before_end() {
    let outgoing = Outgoing::default();
    for content in ["old", "new", "latest"] {
        outgoing.send(ServerMessage::Event {
            id: 1,
            data: json!({"kind":"snapshot", "content":content}),
        });
    }
    outgoing.send(ServerMessage::End { id: 1 });
    let (_, messages) = outgoing.next().await;
    assert_eq!(messages.len(), 2);
    assert!(
        matches!(&messages[0], ServerMessage::Event { data, .. } if data["content"] == "latest")
    );
    assert!(matches!(messages[1], ServerMessage::End { id: 1 }));
}

#[tokio::test]
async fn coalesces_rows_and_unicode_appends_without_reordering_new_rows() {
    let outgoing = Outgoing::default();
    outgoing.send(ServerMessage::Event {
        id: 1,
        data: json!({"type":"batch","updates":[
            {"type":"row","row":{"id":"z","text":"a"}},
            {"type":"row","row":{"id":"a","summary":"old"}},
            {"type":"append","rowId":"y","offset":0,"text":"🛠"}
        ]}),
    });
    outgoing.send(ServerMessage::Event {
        id: 1,
        data: json!({"type":"batch","updates":[
            {"type":"append","rowId":"z","offset":1,"text":"🛠"},
            {"type":"append","rowId":"z","offset":3,"text":"b"},
            {"type":"row","row":{"id":"a","summary":"new"}},
            {"type":"append","rowId":"y","offset":2,"text":"b"}
        ]}),
    });
    let (_, messages) = outgoing.next().await;
    let ServerMessage::Event { data, .. } = &messages[0] else {
        panic!()
    };
    assert_eq!(
        data["updates"],
        json!([
            {"type":"row","row":{"id":"z","text":"a🛠b"}},
            {"type":"row","row":{"id":"a","summary":"new"}},
            {"type":"append","rowId":"y","offset":0,"text":"🛠b"}
        ])
    );
}

#[tokio::test]
async fn a_fresh_snapshot_discards_pending_updates_and_unsubscribe_discards_messages() {
    let outgoing = Outgoing::default();
    outgoing.send(ServerMessage::Event {
        id: 1,
        data: json!({"type":"batch","updates":[
            {"type":"append","rowId":"a","offset":0,"text":"old"}
        ]}),
    });
    outgoing.send(ServerMessage::Event {
        id: 1,
        data: json!({"type":"snapshot","rows":[]}),
    });
    outgoing.send(ServerMessage::End { id: 2 });
    outgoing.remove(2);
    let (_, messages) = outgoing.next().await;
    assert_eq!(messages.len(), 1);
    let ServerMessage::Event { data, .. } = &messages[0] else {
        panic!()
    };
    assert_eq!(data, &json!({"type":"snapshot","rows":[]}));
}

#[tokio::test(start_paused = true)]
async fn a_new_subscription_gets_its_own_deadline_and_data_precedes_end() {
    let outgoing = Outgoing::default();
    outgoing.send(ServerMessage::End { id: 1 });
    outgoing.remove(1);
    tokio::time::advance(std::time::Duration::from_secs(60)).await;
    let now = Instant::now();
    outgoing.send(ServerMessage::Event {
        id: 2,
        data: json!({"type":"snapshot","rows":[]}),
    });
    outgoing.send(ServerMessage::End { id: 2 });
    let (since, messages) = outgoing.next().await;
    assert_eq!(since, now);
    assert!(matches!(
        messages.as_slice(),
        [
            ServerMessage::Event { id: 2, .. },
            ServerMessage::End { id: 2 }
        ]
    ));
}
