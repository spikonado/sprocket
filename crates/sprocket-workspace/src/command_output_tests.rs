use super::*;

#[tokio::test]
async fn preview_counts_omitted_raw_bytes_and_newlines() {
    let root = tempfile::tempdir().unwrap();
    let mut output = CapturedOutput::create(root.path(), 4).await.unwrap();
    output
        .append(OutputChannel::Stdout, "aé\n中\nz!".as_bytes())
        .await
        .unwrap();
    output.finish().await.unwrap();
    let preview = output.take_preview();
    assert_eq!(preview.output, "aéz!");
    assert_eq!(preview.head_chars, 2);
    assert_eq!(preview.output_bytes, 10);
    assert_eq!(preview.total_output_bytes, 10);
    assert_eq!(preview.omitted_bytes, 5);
    assert_eq!(preview.omitted_lines, 2);
    assert_eq!(preview.encoding_loss_bytes, 0);
    assert!(preview.truncated);
    assert_eq!(
        std::fs::read(&preview.log_path).unwrap(),
        "aé\n中\nz!".as_bytes()
    );
}

#[tokio::test]
async fn utf8_split_across_reads_and_polls_is_not_replaced() {
    let root = tempfile::tempdir().unwrap();
    let mut output = CapturedOutput::create(root.path(), 20).await.unwrap();
    output
        .append(OutputChannel::Stdout, &[b'a', 0xf0, 0x9f])
        .await
        .unwrap();
    let first = output.take_preview();
    assert_eq!(first.output, "a");
    assert_eq!(first.encoding_loss_bytes, 0);
    assert_eq!(first.output_bytes, 1);
    assert_eq!(first.total_output_bytes, 3);
    output
        .append(OutputChannel::Stdout, &[0x98, 0x80, b'b'])
        .await
        .unwrap();
    output.finish().await.unwrap();
    let second = output.take_preview();
    assert_eq!(second.output, "😀b");
    assert_eq!(second.encoding_loss_bytes, 0);
    assert_eq!(first.output_bytes + second.output_bytes, 6);
    assert_eq!(second.total_output_bytes, 6);
}

#[tokio::test]
async fn invalid_bytes_and_unfinished_utf8_are_preserved_in_logs() {
    let root = tempfile::tempdir().unwrap();
    let bytes = [b'a', 0xff, 0xe2, 0x82];
    let mut output = CapturedOutput::create(root.path(), 2).await.unwrap();
    output.append(OutputChannel::Stderr, &bytes).await.unwrap();
    output.finish().await.unwrap();
    let preview = output.take_preview();
    assert_eq!(preview.output, "a�");
    assert_eq!(preview.output_bytes, 4);
    assert_eq!(preview.encoding_loss_bytes, 3);
    assert_eq!(preview.omitted_bytes, 1);
    drop(output);
    assert_eq!(std::fs::read(&preview.log_path).unwrap(), bytes);
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
    let preview = output.take_preview();
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
    assert_eq!(bytes, std::fs::read(&preview.log_path).unwrap());
}

#[tokio::test]
async fn zero_preview_limit_still_spools_every_byte() {
    let root = tempfile::tempdir().unwrap();
    let mut output = CapturedOutput::create(root.path(), 0).await.unwrap();
    output
        .append(OutputChannel::Stdout, b"one\ntwo")
        .await
        .unwrap();
    output.finish().await.unwrap();
    let preview = output.take_preview();
    assert!(preview.output.is_empty());
    assert!(preview.truncated);
    assert_eq!(preview.output_bytes, 7);
    assert_eq!(preview.omitted_bytes, 7);
    assert_eq!(preview.omitted_lines, 1);
    assert_eq!(std::fs::read(preview.log_path).unwrap(), b"one\ntwo");
}

#[test]
fn preview_memory_is_bounded_for_large_increments() {
    for limit in [0, 1, 2, 3, 100] {
        let mut buffer = PreviewBuffer::new(limit);
        for _ in 0..2_000_000 {
            buffer.push('x', 1);
        }
        assert_eq!(buffer.head.len() + buffer.tail.len(), limit);
        assert_eq!(buffer.output_bytes, 2_000_000);
        assert_eq!(buffer.omitted_bytes, 2_000_000 - limit as u64);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn log_directory_is_private() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let mut output = CapturedOutput::create(root.path(), 10).await.unwrap();
    let preview = output.take_preview();
    let directory = Path::new(&preview.log_path).parent().unwrap();
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
        let preview = output.take_preview();
        assert_eq!(preview.output, "");
        assert_eq!(preview.total_output_bytes, 0);
        assert!(output.finish().await.is_err());
        assert!(output.log.is_none());
        assert!(output.events.is_none());
    }
}
