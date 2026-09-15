# Command output

`exec_command` and `write_stdin` return incremental previews backed by local
logs. A preview limit never deletes captured bytes from those logs.

## Ordering and storage

One capture task reads stdout and stderr and assigns each chunk a sequence
number. This preserves read-observation order. Separate pipes cannot reveal
the process's exact cross-stream write order when both pipes have buffered
data. Shell and application buffering can also delay writes.

Each command gets a random directory below `command-logs` in the local
transcript directory. On Unix, the command directory has mode `0700`.

- `logPath` is an absolute path to `output.log`, the observed bytes without
  inserted separators or encoding conversion.
- `eventsPath` is an absolute path to `events.jsonl`. Each record has `sequence`,
  `timestampMs`, `channel`, and `bytes`. Sequences start at zero. Timestamps are
  Unix milliseconds. Channels are `stdout` or `stderr`; bytes are JSON arrays
  of unsigned byte values.

The capture task writes and flushes both files before exposing a chunk in a
preview. Completion waits for capture, syncs both files, and closes them.
Capture or storage failures stop the command and return an unsuccessful result
with an error. A drain deadline also reports an error, never successful silent
truncation. Logs from failed capture can contain only a prefix, and their last
event can be incomplete. A crash before completion does not promise synced logs.

Logs survive session cleanup, agent-run completion, and application restart.
They are local files, not uploaded artifacts. There is no automatic log expiry
or disk quota in this change. They remain until the local transcript data or
the command log directory is deleted. Full logs can contain secrets and can
consume substantially more disk space than raw output because the event file
also records every byte. If storage runs out, capture fails explicitly rather
than discarding old output. Session quotas and log-retention policy are separate
work from output correctness.

## Preview fields

`maxOutputChars` bounds Unicode scalar values, with a maximum of 80,000.
Zero returns an empty preview but still captures output. If a preview exceeds
the limit, its head gets the rounded-up half and its tail gets the rest.

- `output` concatenates the head and tail without a truncation marker.
- `truncated` reports whether this increment omitted any bytes.
- `headChars` gives the gap's character offset when `truncated` is true.
- `outputBytes` counts source bytes represented or omitted in this increment.
- `omittedBytes` counts source bytes excluded from the preview.
- `omittedLines` counts newline bytes in the omitted portion, not partial lines.
- `encodingLossBytes` counts source bytes replaced during UTF-8 decoding,
  including replacements in the omitted portion.
- `totalOutputBytes` counts all bytes captured so far, including a pending UTF-8
  suffix that has not yet appeared in a preview.

The preview decodes the combined raw log as UTF-8. Incomplete characters wait
for the next chunk, even across polls; an incomplete suffix at completion becomes
a replacement character. Invalid bytes remain unchanged in both logs. If
streams interleave in the middle of a multibyte character, the combined preview
can have encoding loss. The event log preserves each channel's original bytes
for separate decoding.

## Completed sessions

Running polls consume the next increment. Once an observer obtains completion,
later observers receive the same final increment and exit status, not an
unknown-session error. This is a replay, not new output. Earlier increments
remain in the logs. Final results stay available for the lifetime of the agent
run; `stop_all` and `terminate_all` clear the session registry but not the files.
Session IDs still do not survive a restart or identify sessions in later runs.

## Verification

Regression tests first failed against the original implementation for
stdout/stderr reordering, prefix-only truncation, and immediate removal of
completed results. Tests also cover output larger than the former capture
buffers, persistence after cleanup, bounded preview memory, split and invalid
UTF-8, zero-sized previews, omission counts, log-write failures, and capture
drain failures.
