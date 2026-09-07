use super::types::{
    TRANSCRIPT_CHUNK_SIZE, TRANSCRIPT_PAGE_SIZE, TranscriptPart, TranscriptPartKind,
};

pub fn parts_window(visible_end: u32, before: Option<u32>, limit: Option<u32>) -> (u32, u32) {
    let limit = limit
        .unwrap_or(TRANSCRIPT_PAGE_SIZE)
        .clamp(1, TRANSCRIPT_CHUNK_SIZE);
    let end_exclusive = before.unwrap_or(visible_end).min(visible_end);
    (end_exclusive.saturating_sub(limit), end_exclusive)
}

pub fn message_page_start(
    parts: &[TranscriptPart],
    message_limit: u32,
    reached_history_start: bool,
) -> Option<u32> {
    let mut ordered = parts.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|part| part.number);
    let mut current_key: Option<(bool, &str)> = None;
    let mut current_start = None;
    let mut completed = 0;

    for part in ordered.into_iter().rev() {
        let key = match part.kind {
            TranscriptPartKind::Prompt => (true, part.run_id.as_str()),
            TranscriptPartKind::Completion | TranscriptPartKind::Tool => {
                (false, part.run_id.as_str())
            }
        };
        match current_key {
            None => {
                current_key = Some(key);
                current_start = Some(part.number);
            }
            Some(existing) if existing == key => current_start = Some(part.number),
            Some(_) => {
                completed += 1;
                if completed >= message_limit.max(1) {
                    return current_start;
                }
                current_key = Some(key);
                current_start = Some(part.number);
            }
        }
    }

    if reached_history_start && current_key.is_some() {
        Some(current_start.unwrap_or(0))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::types::{TranscriptCompletionBody, TranscriptPromptBody};

    fn prompt(number: u32, run_id: &str) -> TranscriptPart {
        TranscriptPart {
            number,
            source_key: format!("prompt:{number}"),
            kind: TranscriptPartKind::Prompt,
            run_id: run_id.to_string(),
            created_at: None,
            prompt: Some(TranscriptPromptBody {
                text: run_id.to_string(),
                image_uploads: Vec::new(),
            }),
            completion: None,
            tool: None,
        }
    }

    fn completion(number: u32, run_id: &str) -> TranscriptPart {
        TranscriptPart {
            number,
            source_key: format!("completion:{number}"),
            kind: TranscriptPartKind::Completion,
            run_id: run_id.to_string(),
            created_at: None,
            prompt: None,
            completion: Some(TranscriptCompletionBody {
                stream_id: None,
                items: Vec::new(),
            }),
            tool: None,
        }
    }

    #[test]
    fn parts_window_takes_a_numeric_slice_inside_five_hundred_parts() {
        assert_eq!(parts_window(500, None, None), (460, 500));
        assert_eq!(parts_window(500, Some(200), Some(40)), (160, 200));
        assert_eq!(parts_window(500, Some(10), Some(40)), (0, 10));
        assert_eq!(parts_window(100, Some(500), Some(200)), (0, 100));
    }

    #[test]
    fn message_page_start_waits_for_complete_messages() {
        let parts = [
            prompt(0, "run-0"),
            completion(1, "run-0"),
            prompt(2, "run-2"),
            completion(3, "run-2"),
            completion(4, "run-2"),
        ];
        assert_eq!(message_page_start(&parts, 1, false), Some(3));
        assert_eq!(message_page_start(&parts[3..], 1, false), None);
        assert_eq!(message_page_start(&parts[0..1], 1, true), Some(0));
    }
}
