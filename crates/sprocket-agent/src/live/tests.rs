use super::*;

fn overlay(thread_id: &str, text: &str) -> LiveCompletionOverlay {
    LiveCompletionOverlay {
        thread_id: thread_id.to_string(),
        run_id: "run-1".to_string(),
        run_status: "running".to_string(),
        stream_id: "stream-1".to_string(),
        text: text.to_string(),
        parts: vec![LiveAssistantPart::Text {
            id: "t".to_string(),
            text: text.to_string(),
            started_at: None,
            completed_at: None,
            turn_id: Some("stream-1".to_string()),
        }],
        run_started_at: 1,
    }
}

#[test]
fn live_parts_keep_old_json_without_timing() {
    let part: LiveAssistantPart = serde_json::from_value(serde_json::json!({
        "type": "text",
        "id": "t",
        "text": "hello",
        "turnId": "stream-1"
    }))
    .unwrap();
    assert_eq!(
        part,
        LiveAssistantPart::Text {
            id: "t".into(),
            text: "hello".into(),
            started_at: None,
            completed_at: None,
            turn_id: Some("stream-1".into()),
        }
    );
}

#[test]
fn text_and_reasoning_record_start_once_and_update_end() {
    let mut parts = LiveAssistantParts::default();
    parts.apply_text_delta("text", "t".into(), "Hello", Some("turn".into()), 10);
    parts.apply_text_delta("text", "t".into(), "!", Some("turn".into()), 25);
    parts.apply_text_delta("reasoning", "r".into(), "think", Some("turn".into()), 11);
    parts.apply_text_delta("reasoning", "r".into(), " more", Some("turn".into()), 40);

    assert_eq!(
        parts.parts,
        vec![
            LiveAssistantPart::Text {
                id: "t".into(),
                text: "Hello!".into(),
                started_at: Some(10),
                completed_at: Some(25),
                turn_id: Some("turn".into()),
            },
            LiveAssistantPart::Reasoning {
                id: "r".into(),
                text: "think more".into(),
                started_at: Some(11),
                completed_at: Some(40),
                turn_id: Some("turn".into()),
            }
        ]
    );
    assert_eq!(
        serde_json::to_value(&parts.parts).unwrap()[0]["startedAt"],
        serde_json::json!(10)
    );
}

#[test]
fn completed_text_replaces_deltas_even_when_the_authoritative_text_is_empty() {
    let mut parts = LiveAssistantParts::default();
    parts.apply_text_delta("text", "t".into(), "partial", Some("turn".into()), 10);
    parts.apply_text_delta("reasoning", "r".into(), "thinking", Some("turn".into()), 20);

    assert_eq!(
        parts.apply_completed_text("t".into(), "done".into(), Some("turn".into()), 30),
        "partial"
    );
    assert_eq!(
        parts.apply_completed_text("t".into(), String::new(), Some("turn".into()), 40),
        "done"
    );
    assert_eq!(
        parts.parts[0],
        LiveAssistantPart::Text {
            id: "t".into(),
            text: String::new(),
            started_at: Some(10),
            completed_at: Some(40),
            turn_id: Some("turn".into()),
        }
    );
    assert_eq!(parts.parts.len(), 2);
    assert!(matches!(
        &parts.parts[1],
        LiveAssistantPart::Reasoning { text, .. } if text == "thinking"
    ));
}

#[test]
fn tool_replacement_keeps_the_original_start() {
    let mut parts = LiveAssistantParts::default();
    parts.apply_tool_call(
        Some("p1".into()),
        "c1".into(),
        "exec_command".into(),
        serde_json::json!({"cmd": "echo"}),
        Some("turn".into()),
        50,
    );
    parts.apply_tool_call(
        Some("p1".into()),
        "c1".into(),
        "exec_command".into(),
        serde_json::json!({"cmd": "ls"}),
        Some("turn".into()),
        80,
    );

    assert_eq!(
        parts.parts,
        vec![LiveAssistantPart::ToolCall {
            part_id: Some("p1".into()),
            call_id: "c1".into(),
            name: "exec_command".into(),
            input: serde_json::json!({"cmd": "ls"}),
            started_at: Some(50),
            completed_at: Some(80),
            turn_id: Some("turn".into()),
        }]
    );
}

#[test]
fn completed_reasoning_keeps_delta_start_and_sets_end() {
    let mut parts = LiveAssistantParts::default();
    parts.apply_text_delta("reasoning", "s:c".into(), "partial", Some("s".into()), 10);
    parts.apply_completed_reasoning("s:c".into(), "done".into(), Some("s".into()), 50);

    assert_eq!(
        parts.parts,
        vec![LiveAssistantPart::Reasoning {
            id: "s:c".into(),
            text: "done".into(),
            started_at: Some(10),
            completed_at: Some(50),
            turn_id: Some("s".into()),
        }]
    );
}

#[test]
fn empty_completed_reasoning_sets_start_and_end() {
    let mut parts = LiveAssistantParts::default();
    parts.apply_completed_reasoning("s:c".into(), String::new(), Some("s".into()), 70);

    assert_eq!(
        parts.parts,
        vec![LiveAssistantPart::Reasoning {
            id: "s:c".into(),
            text: String::new(),
            started_at: Some(70),
            completed_at: Some(70),
            turn_id: Some("s".into()),
        }]
    );
}

#[test]
fn completed_reasoning_appends_when_indexed_slot_is_not_reasoning() {
    let mut parts = LiveAssistantParts::default();
    parts.apply_text_delta("reasoning", "s:c".into(), "stale", Some("s".into()), 10);
    parts.parts[0] = LiveAssistantPart::ToolCall {
        part_id: Some("p1".into()),
        call_id: "c1".into(),
        name: "exec_command".into(),
        input: serde_json::json!({"cmd": "pwd"}),
        started_at: Some(10),
        completed_at: Some(10),
        turn_id: Some("s".into()),
    };
    parts.apply_completed_reasoning("s:c".into(), "late".into(), Some("s".into()), 90);
    parts.apply_completed_reasoning("s:c".into(), "late again".into(), Some("s".into()), 95);

    assert_eq!(
        parts.parts,
        vec![
            LiveAssistantPart::ToolCall {
                part_id: Some("p1".into()),
                call_id: "c1".into(),
                name: "exec_command".into(),
                input: serde_json::json!({"cmd": "pwd"}),
                started_at: Some(10),
                completed_at: Some(10),
                turn_id: Some("s".into()),
            },
            LiveAssistantPart::Reasoning {
                id: "s:c".into(),
                text: "late again".into(),
                started_at: Some(90),
                completed_at: Some(95),
                turn_id: Some("s".into()),
            }
        ]
    );
}

#[tokio::test]
async fn publish_replaces_snapshot_and_fans_out() {
    let hub = LiveCompletionHub::new();
    let mut first = hub.subscribe("thread-1");
    let mut second = hub.subscribe("thread-1");
    assert!(first.snapshot.is_none());
    assert!(second.snapshot.is_none());

    let live = overlay("thread-1", "Hello");
    hub.publish(live.clone());

    assert_eq!(hub.snapshot("thread-1").as_ref(), Some(&live));
    assert_eq!(
        first.receiver.recv().await.expect("first subscriber"),
        LiveCompletionWatchEvent::Updated { live: live.clone() }
    );
    assert_eq!(
        second.receiver.recv().await.expect("second subscriber"),
        LiveCompletionWatchEvent::Updated { live }
    );
}

#[test]
fn late_joiner_receives_current_snapshot() {
    let hub = LiveCompletionHub::new();
    hub.publish(overlay("thread-1", "partial"));
    let late = hub.subscribe("thread-1");
    assert_eq!(
        late.snapshot.as_ref().map(|live| live.text.as_str()),
        Some("partial")
    );
}

#[tokio::test]
async fn clear_drops_snapshot_and_notifies() {
    let hub = LiveCompletionHub::new();
    let mut subscriber = hub.subscribe("thread-1");
    hub.publish(overlay("thread-1", "partial"));
    let _ = subscriber.receiver.recv().await;
    hub.clear("thread-1");
    assert!(hub.snapshot("thread-1").is_none());
    assert_eq!(
        subscriber.receiver.recv().await.expect("cleared"),
        LiveCompletionWatchEvent::Cleared
    );
    let late = hub.subscribe("thread-1");
    assert!(late.snapshot.is_none());
}

#[test]
fn clear_drops_idle_slots_without_subscribers() {
    let hub = LiveCompletionHub::new();
    hub.publish(overlay("thread-1", "partial"));
    assert_eq!(hub.slot_count(), 1);
    hub.clear("thread-1");
    assert_eq!(hub.slot_count(), 0);
    assert!(hub.snapshot("thread-1").is_none());
}
