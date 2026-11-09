use rig::message::{CallId, ToolName};

use super::*;

fn screenshot() -> Arc<Message> {
    Arc::new(Message::User {
        content: vec![UserContent::tool_result(
            CallId::from_wire("call"),
            ToolName::new("parse_file").unwrap(),
            vec![ToolResultContent::image_url(
                "https://example.com/a.png",
                None,
                None,
            )],
        )],
    })
}

#[test]
fn omitted_images_stay_fixed_until_another_batch_arrives() {
    let kept: Vec<usize> = [20, 21, 29, 30, 31]
        .into_iter()
        .map(|total| total - images_to_omit(total))
        .collect();
    assert_eq!(kept, [20, 11, 19, 10, 11]);
}

#[test]
fn replaces_the_oldest_images_with_a_note() {
    let upload = Arc::new(Message::User {
        content: vec![UserContent::image_url(
            "https://example.com/b.png",
            None,
            None,
        )],
    });
    let history = [upload, screenshot(), screenshot()];
    let trimmed = omit_oldest_images(&history, 2);
    let counts: Vec<usize> = trimmed.iter().map(|message| image_count(message)).collect();
    assert_eq!(counts, [0, 0, 1]);
    let Message::User { content } = &*trimmed[1] else {
        panic!("user message");
    };
    let UserContent::ToolResult(result) = &content[0] else {
        panic!("tool result");
    };
    assert_eq!(result.content[0].as_text(), Some(OMITTED_IMAGE));
}
