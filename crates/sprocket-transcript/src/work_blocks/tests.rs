use serde_json::{Value, json};

use super::*;

fn completion(number: u32, run: &str, items: Vec<Value>) -> TranscriptPart {
    serde_json::from_value(json!({
        "number": number,
        "sourceKey": format!("completion:{run}:{number}"),
        "kind": "completion",
        "runId": run,
        "completion": {"items": items},
        "work": {"ranges": [{"start": 0, "end": 1, "sectionKey": "ignored"}]}
    }))
    .unwrap()
}

#[test]
fn ordered_items_define_blocks_across_parts() {
    let parts = [
        completion(
            0,
            "run",
            vec![
                json!({"type":"reasoning", "text":" \n"}),
                json!({"type":"text", "text":"before"}),
                json!({"type":"reasoning", "text":"thinking"}),
            ],
        ),
        completion(
            2,
            "run",
            vec![
                json!({"type":"text", "text":"\t"}),
                json!({"type":"tool-call", "callId":"call", "name":"read_file"}),
                json!({"type":"text", "text":"answer"}),
                json!({"type":"reasoning", "text":"next"}),
            ],
        ),
        completion(3, "run", vec![json!({"type":"reasoning", "text":"more"})]),
    ];
    let blocks = derive_work_blocks(&parts);
    assert_eq!(blocks.len(), 2);
    assert_eq!(
        blocks[0].items,
        [
            WorkPosition { part: 0, item: 2 },
            WorkPosition { part: 2, item: 1 }
        ]
    );
    assert!(blocks[0].closed);
    assert_eq!(
        blocks[1].items,
        [
            WorkPosition { part: 2, item: 3 },
            WorkPosition { part: 3, item: 0 }
        ]
    );
    assert!(!blocks[1].closed);
    let mut renumbered = parts[0].clone();
    renumbered.number = 42;
    assert_eq!(derive_work_blocks([&renumbered])[0].id, blocks[0].id);
}

#[test]
fn each_run_keeps_its_own_open_block() {
    let parts = [
        completion(0, "a", vec![json!({"type":"reasoning", "text":"thinking"})]),
        completion(
            1,
            "b",
            vec![json!({"type":"reasoning", "text":"also thinking"})],
        ),
        completion(2, "a", vec![json!({"type":"text", "text":"done"})]),
        completion(
            3,
            "b",
            vec![json!({"type":"tool-call", "callId":"call", "name":"read_file"})],
        ),
    ];
    let blocks = derive_work_blocks(&parts);
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0].run_id, "a");
    assert!(blocks[0].closed);
    assert_eq!(blocks[1].run_id, "b");
    assert!(!blocks[1].closed);
    assert_eq!(blocks[1].items.len(), 2);
}
