use super::*;

impl CapturedOutput {
    async fn read_log(&self, from_offset: u64, final_stream: bool) -> UnreturnedOutput {
        read_log_from(
            Path::new(&self.log_path),
            from_offset,
            self.full_preview.max_chars,
            final_stream,
        )
        .await
        .unwrap()
    }
}

#[tokio::test]
async fn full_preview_and_disk_recovery_match_with_bounded_utf8() {
    let root = tempfile::tempdir().unwrap();
    let mut output = CapturedOutput::create(root.path(), 40).await.unwrap();
    let text = format!("start\n{}end\n", "é\n".repeat(5_000));
    for chunk in text.as_bytes().chunks(31) {
        output.append(OutputChannel::Stdout, chunk).await.unwrap();
    }
    output
        .append(OutputChannel::Stderr, &[0xff, 0xc3])
        .await
        .unwrap();
    output.finish().await.unwrap();
    let full = output.full_preview();
    assert!(full.output.starts_with("start\n"));
    assert!(full.output.ends_with("end\n\u{fffd}\u{fffd}"));
    assert!(full.output.chars().count() <= 40);
    assert_eq!(output.read_log(0, true).await.output, full.output);
}

#[tokio::test]
async fn log_quota_counts_both_files_and_rejects_a_chunk_before_writing() {
    let root = tempfile::tempdir().unwrap();
    let mut output = CapturedOutput::create(root.path(), 20).await.unwrap();
    output.append(OutputChannel::Stdout, b"ok").await.unwrap();
    let log = std::fs::read(&output.log_path).unwrap();
    let events = std::fs::read(&output.events_path).unwrap();
    assert_eq!(output.log_bytes, (log.len() + events.len()) as u64);
    output.limits.max_log_bytes = output.log_bytes + 3;
    let error = output
        .append(OutputChannel::Stderr, b"x")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("log quota"));
    output.finish().await.unwrap();
    assert_eq!(output.read_log(0, true).await.output, "ok");
    assert_eq!(std::fs::read(&output.log_path).unwrap(), log);
    assert_eq!(std::fs::read(&output.events_path).unwrap(), events);
}

#[tokio::test]
async fn free_space_reserve_is_checked_again_before_appending() {
    let root = tempfile::tempdir().unwrap();
    let mut output = CapturedOutput::create(root.path(), 20).await.unwrap();
    output.limits.min_free_disk_bytes = u64::MAX;
    let error = output
        .append(OutputChannel::Stdout, b"full")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("free-space reserve"));
    output.finish().await.unwrap();
    assert!(std::fs::read(&output.log_path).unwrap().is_empty());
    assert!(std::fs::read(&output.events_path).unwrap().is_empty());
}

#[tokio::test]
async fn preview_marks_omitted_lines_and_preserves_the_full_log() {
    let root = tempfile::tempdir().unwrap();
    let mut output = CapturedOutput::create(root.path(), 40).await.unwrap();
    let text = "a\n".repeat(50);
    output
        .append(OutputChannel::Stdout, text.as_bytes())
        .await
        .unwrap();
    output.finish().await.unwrap();
    let preview = output.read_log(0, true).await;
    assert_eq!(
        preview.output,
        format!(
            "{}\n<40 lines omitted>\n{}",
            "a\n".repeat(5),
            "a\n".repeat(5)
        )
    );
    assert_eq!(preview.output.chars().count(), 40);
    assert_eq!(std::fs::read(&output.log_path).unwrap(), text.as_bytes());
}

#[test]
fn untruncated_output_is_unchanged_at_the_limit() {
    for text in ["", "short\n", &"é".repeat(30)] {
        let mut preview = PreviewBuffer::new(30);
        preview.push_text(text);
        assert_eq!(preview.render(), text);
    }
}

#[test]
fn a_single_character_overflow_makes_room_for_the_whole_marker() {
    let mut preview = PreviewBuffer::new(30);
    preview.push_text(&format!("{}b", "a".repeat(30)));
    assert_eq!(preview.render(), "aaaaaa\n<1 line omitted>\naaaaab");
}

#[test]
fn omission_count_includes_characters_removed_to_fit_a_longer_count() {
    let mut preview = PreviewBuffer::new(40);
    preview.push_text(&"\n".repeat(120));
    let output = preview.render();
    assert_eq!(
        output,
        format!(
            "{}\n<101 lines omitted>\n{}",
            "\n".repeat(10),
            "\n".repeat(9)
        )
    );
    assert_eq!(output.chars().count(), 40);
}

#[test]
fn unicode_preview_limits_count_characters_including_the_marker() {
    let mut preview = PreviewBuffer::new(30);
    preview.push_text(&"é".repeat(100));
    let output = preview.render();
    assert_eq!(
        output,
        format!("{}\n<1 line omitted>\n{}", "é".repeat(6), "é".repeat(6))
    );
    assert_eq!(output.chars().count(), 30);
}

#[tokio::test]
async fn each_poll_gets_its_own_omission_notice() {
    let root = tempfile::tempdir().unwrap();
    let mut output = CapturedOutput::create(root.path(), 40).await.unwrap();
    output
        .append(OutputChannel::Stdout, &[b'\n'; 120])
        .await
        .unwrap();
    let first = output.read_log(0, false).await;
    assert!(first.output.contains("<101 lines omitted>"));
    output.append(OutputChannel::Stdout, b"next").await.unwrap();
    let second = output.read_log(first.next_offset, false).await;
    assert_eq!(second.output, "next");
    let third = output.read_log(second.next_offset, false).await;
    assert_eq!(third.output, "");
    assert_eq!(third.next_offset, second.next_offset);
    output.finish().await.unwrap();
}

#[tokio::test]
async fn utf8_split_across_reads_and_polls_is_not_replaced() {
    let root = tempfile::tempdir().unwrap();
    let mut output = CapturedOutput::create(root.path(), 20).await.unwrap();
    output
        .append(OutputChannel::Stdout, &[b'a', 0xf0, 0x9f])
        .await
        .unwrap();
    let first = output.read_log(0, false).await;
    assert_eq!(first.output, "a");
    output
        .append(OutputChannel::Stdout, &[0x98, 0x80, b'b'])
        .await
        .unwrap();
    output.finish().await.unwrap();
    let second = output.read_log(first.next_offset, true).await;
    assert_eq!(second.output, "😀b");
    assert_eq!(std::fs::read(&output.log_path).unwrap(), "a😀b".as_bytes());
}

#[tokio::test]
async fn unfinished_character_is_replaced_once_when_the_stream_ends() {
    let root = tempfile::tempdir().unwrap();
    let mut output = CapturedOutput::create(root.path(), 20).await.unwrap();
    output
        .append(OutputChannel::Stdout, &[b'a', 0xe2])
        .await
        .unwrap();
    let live = output.read_log(0, false).await;
    assert_eq!((live.output.as_str(), live.next_offset), ("a", 1));
    output.finish().await.unwrap();
    let last = output.read_log(live.next_offset, true).await;
    assert_eq!(last.output, "\u{fffd}");
    let after = output.read_log(last.next_offset, true).await;
    assert_eq!(after.output, "");
    assert_eq!(after.next_offset, last.next_offset);
}

#[tokio::test]
async fn invalid_bytes_and_unfinished_utf8_are_preserved_in_logs() {
    let root = tempfile::tempdir().unwrap();
    let bytes = [b'a', 0xff, 0xe2, 0x82];
    let mut output = CapturedOutput::create(root.path(), 20).await.unwrap();
    output.append(OutputChannel::Stderr, &bytes).await.unwrap();
    output.finish().await.unwrap();
    assert_eq!(output.read_log(0, true).await.output, "a��");
    let preview = output.full_preview();
    assert_eq!(preview.output, "a��");
    drop(output);
    assert_eq!(std::fs::read(&preview.complete_log_path).unwrap(), bytes);
    let events = std::fs::read_to_string(preview.events_path).unwrap();
    let event: serde_json::Value = serde_json::from_str(events.trim()).unwrap();
    assert_eq!(event["bytes"], serde_json::json!(bytes));
    assert_eq!(event["channel"], "stderr");
}

#[tokio::test]
async fn events_record_observed_channel_order_without_inserted_newlines() {
    let root = tempfile::tempdir().unwrap();
    let mut output = CapturedOutput::create(root.path(), 20).await.unwrap();
    for (channel, bytes) in [
        (OutputChannel::Stdout, b"start".as_slice()),
        (OutputChannel::Stderr, b"fail".as_slice()),
        (OutputChannel::Stdout, b"end".as_slice()),
    ] {
        output.append(channel, bytes).await.unwrap();
    }
    output.finish().await.unwrap();
    let preview = output.full_preview();
    assert_eq!(preview.output, "startfailend");
    let events: Vec<serde_json::Value> = std::fs::read_to_string(&preview.events_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let mut bytes = Vec::new();
    for (sequence, event) in events.iter().enumerate() {
        assert_eq!(event["sequence"], sequence);
        assert!(event["timestampMs"].as_u64().unwrap() > 0);
        bytes.extend(serde_json::from_value::<Vec<u8>>(event["bytes"].clone()).unwrap());
    }
    assert_eq!(events[1]["channel"], "stderr");
    assert_eq!(bytes, std::fs::read(&preview.complete_log_path).unwrap());
}

#[tokio::test]
async fn zero_preview_limit_keeps_the_notice_and_spools_every_byte() {
    let root = tempfile::tempdir().unwrap();
    let mut output = CapturedOutput::create(root.path(), 0).await.unwrap();
    output
        .append(OutputChannel::Stdout, b"one\ntwo")
        .await
        .unwrap();
    output.finish().await.unwrap();
    let preview = output.full_preview();
    assert_eq!(preview.output, "\n<2 lines omitted>\n");
    assert_eq!(
        std::fs::read(preview.complete_log_path).unwrap(),
        b"one\ntwo"
    );
}

#[test]
fn preview_memory_is_bounded_for_large_increments() {
    for limit in [0, 1, 2, 3, 100] {
        let mut buffer = PreviewBuffer::new(limit);
        for _ in 0..2_000_000 {
            buffer.push('x');
        }
        assert_eq!(buffer.head.len() + buffer.tail.len(), limit);
        let preview = buffer.render();
        assert!(preview.contains("<1 line omitted>"));
        assert_eq!(
            preview.chars().count(),
            limit.max("\n<1 line omitted>\n".len())
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn log_directory_is_private() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let mut output = CapturedOutput::create(root.path(), 10).await.unwrap();
    let preview = output.preview_metadata();
    let directory = Path::new(&preview.complete_log_path).parent().unwrap();
    assert_eq!(
        std::fs::metadata(directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    output.finish().await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn disk_write_failure_does_not_advance_preview() {
    for fail_events in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let mut output = CapturedOutput::create(root.path(), 10).await.unwrap();
        let full = File::options().write(true).open("/dev/full").await.unwrap();
        if fail_events {
            output.events = Some(full);
        } else {
            output.log = Some(full);
        }
        assert!(output.append(OutputChannel::Stdout, b"lost").await.is_err());
        assert_eq!(output.full_preview().output, "");
        assert!(output.finish().await.is_err());
        assert!(output.log.is_none());
        assert!(output.events.is_none());
    }
}

fn event(sequence: u64, channel: &str, bytes: &[u8]) -> Vec<u8> {
    let mut encoded = serde_json::to_vec(&serde_json::json!({
        "sequence": sequence,
        "timestampMs": 123,
        "channel": channel,
        "bytes": bytes,
    }))
    .unwrap();
    encoded.push(b'\n');
    encoded
}

#[cfg(unix)]
#[tokio::test]
async fn captured_command_events_rebuild_the_original_log() {
    use crate::{CommandSessionManager, WorkspaceCancellation, default_command_shell};

    let directory = tempfile::tempdir().unwrap();
    let sessions =
        CommandSessionManager::new(directory.path().into(), directory.path().join("logs"));
    let captured = sessions
        .exec_command(
            WorkspaceCancellation::new(),
            "printf '\\033[32mready\\000\\377\\n'; printf 'warning\\n' >&2",
            ".",
            &default_command_shell(),
            None,
            5_000,
            20_000,
        )
        .await
        .unwrap();
    assert!(captured.result.success);
    let output = directory.path().join("rebuilt.log");
    rebuild_output(Path::new(&captured.result.events_path), &output, false)
        .await
        .unwrap();
    assert_eq!(
        tokio::fs::read(output).await.unwrap(),
        tokio::fs::read(captured.result.complete_log_path)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn downloaded_events_rebuild_exact_combined_output_across_partial_batches() {
    let directory = tempfile::tempdir().unwrap();
    let events = directory.path().join("events.jsonl");
    let output = directory.path().join("output.log");
    tokio::fs::write(&events, b"").await.unwrap();
    rebuild_output(&events, &output, false).await.unwrap();
    assert_eq!(tokio::fs::read(&output).await.unwrap(), b"");
    let first = event(0, "stdout", b"\x1b[32mready\x00\xff\n");
    let second = event(1, "stderr", b"warning\n");
    let third = event(2, "stdout", "done \u{1f680}\n".as_bytes());
    let mut downloaded = first.clone();
    downloaded.extend_from_slice(&second[..second.len() / 2]);
    tokio::fs::write(&events, &downloaded).await.unwrap();
    rebuild_output(&events, &output, true).await.unwrap();
    assert_eq!(
        tokio::fs::read(&output).await.unwrap(),
        b"\x1b[32mready\x00\xff\n"
    );

    downloaded.extend_from_slice(&second[second.len() / 2..]);
    downloaded.extend_from_slice(&third);
    tokio::fs::write(&events, &downloaded).await.unwrap();
    let expected = [
        b"\x1b[32mready\x00\xff\nwarning\n".as_slice(),
        "done \u{1f680}\n".as_bytes(),
    ]
    .concat();
    for _ in 0..2 {
        rebuild_output(&events, &output, false).await.unwrap();
        assert_eq!(tokio::fs::read(&output).await.unwrap(), expected);
    }
    assert_eq!(tokio::fs::read(&events).await.unwrap(), downloaded);
}

#[tokio::test]
async fn invalid_events_preserve_the_previous_output() {
    let directory = tempfile::tempdir().unwrap();
    let events = directory.path().join("events.jsonl");
    let output = directory.path().join("output.log");
    tokio::fs::write(&output, b"previous output").await.unwrap();
    let incomplete = event(0, "stdout", b"unfinished");
    for bytes in [
        event(1, "stdout", b"sequence gap"),
        b"not JSON\n".to_vec(),
        incomplete[..incomplete.len() - 1].to_vec(),
    ] {
        tokio::fs::write(&events, bytes).await.unwrap();
        assert!(rebuild_output(&events, &output, false).await.is_err());
        assert_eq!(tokio::fs::read(&output).await.unwrap(), b"previous output");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn resumed_output_continues_from_the_last_complete_event() {
    let root = tempfile::tempdir().unwrap();
    let mut output = CapturedOutput::create(root.path(), 100).await.unwrap();
    output.append(OutputChannel::Stdout, b"out ").await.unwrap();
    output.append(OutputChannel::Stderr, b"err").await.unwrap();
    output.finish().await.unwrap();
    let preview = output.preview_metadata();
    // A server that died mid-append leaves a torn event, and log bytes that no event covers.
    let mut events = std::fs::read(&preview.events_path).unwrap();
    events.extend_from_slice(&event(2, "stdout", b"lost")[..10]);
    std::fs::write(&preview.events_path, events).unwrap();
    std::fs::write(&preview.complete_log_path, b"out errlost").unwrap();

    let (mut resumed, captured) = CapturedOutput::resume(
        preview.complete_log_path.clone(),
        preview.events_path.clone(),
        100,
        CommandOutputLimits::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        captured,
        CapturedBytes {
            stdout: 4,
            stderr: 3
        }
    );
    resumed
        .append(OutputChannel::Stdout, b" more")
        .await
        .unwrap();
    resumed.finish().await.unwrap();

    assert_eq!(resumed.full_preview().output, "out err more");
    assert_eq!(
        std::fs::read(&preview.complete_log_path).unwrap(),
        b"out err more"
    );
    let rebuilt = root.path().join("rebuilt.log");
    rebuild_output(Path::new(&preview.events_path), &rebuilt, false)
        .await
        .unwrap();
    assert_eq!(std::fs::read(rebuilt).unwrap(), b"out err more");
}
