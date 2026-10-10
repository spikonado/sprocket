# sprocket-agent

`sprocket-agent` owns the local lifecycle of an agent run. It coordinates
durable run state in Convex, streams completions through the AI gateway, and
exposes local workspace tools.

It is used by `sprocket-server` and depends on
[`sprocket-convex`](../sprocket-convex) and
[`sprocket-workspace`](../sprocket-workspace/README.md).

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the distributed run protocol.

## Run lifecycle

An agent run:

1. creates or recovers durable run state;
2. resolves the workspace and loads applicable instructions;
3. reconstructs prior model history;
4. acquires and renews ownership of the run;
5. posts OpenAI Responses API completions to the AI gateway and runs local tools; and
6. records a terminal result.

Creation is retryable through the submission identifier. The run claim prevents
an old worker from executing tools or finalizing after ownership has moved.
Failure paths attempt to reconcile partially created or claimed runs so durable
state does not remain indefinitely active.

## Built-in skills

Built-in skills live in [`sprocket-workspace/skills`](../sprocket-workspace/skills)
and are discovered at run time with project and user skills. See that crate for
the on-disk layout.

`SKILL.md` accepts an optional `disable-model-invocation` YAML boolean, defaulting
to `false`. Setting it to `true` omits the skill's name and description from the
model's workspace context, which is also reused after handoff. The skill stays
in the host registry and user skill picker with normal precedence. Users can
explicitly request it with `$skill-name`, and the agent can call `read_skill`
as usual. Invalid or duplicate values skip the skill with a discovery warning.
This is prompt filtering, not access control. `read_skill` remains unchanged and
can still read any registered skill.

The field is a [Claude Code](https://code.claude.com/docs/en/skills#control-who-invokes-a-skill)
and [Cursor](https://cursor.com/docs/skills#disabling-automatic-invocation)
extension, not part of the core [Agent Skills specification](https://agentskills.io/specification).
[Codex](https://developers.openai.com/codex/skills#optional-metadata) uses
`policy.allow_implicit_invocation: false` in `agents/openai.yaml` instead.
Sprocket does not read that sidecar policy or enforce tool-call authorization.

## Tools

Message attachments can contain any file type, with no application size or count
limit. The UI streams them through Rust to Convex storage. Each thread keeps its
local copies in `attachments/` under the transcript cache. Prompts list those
local paths; attaching an image does not put its pixels in model context.

`parse_file` accepts a local filesystem path. Firecrawl's AnyDoc Rust library
converts supported office documents and PDFs to Markdown locally. UTF-8 text is
returned as text. Failed local document conversions automatically upload a
temporary copy to Firecrawl's hosted Parse API, including OCR for scanned PDFs.
There is no permission prompt or Firecrawl charge to the user. The backend uses
its `FIRECRAWL_API_KEY`; when it is not configured, the tool reports that hosted
fallback is unavailable. Long parsed results include a preview and the path to
the full text in the thread's `parse_file/` cache. Use `scrape_url` for http(s)
URLs; `parse_file` rejects a `url` argument and URL-shaped paths.
Hosted parsing still calls Firecrawl's Parse API directly because the official
Convex component does not expose parsing.

`scrape_url` downloads supported raster images and returns their pixels
to image-capable models. Short text scrapes are not saved locally.
GitHub repository file URLs using `/blob/`, `/raw/`, or `/blame/` map to
`raw.githubusercontent.com` before any image or Markdown probe. Direct raw URLs
use this route too. The mapping preserves refs, encoded paths, and query
parameters, and drops line anchors. Rust reads source files as UTF-8, converts
supported documents with AnyDoc, and returns supported images through the
existing image cache. This route never calls Firecrawl, even after a download
or parsing failure. It has a 30-second download timeout, five-redirect limit,
and 64 MiB download limit. Image signatures lower the download limit to 20 MiB
during streaming, regardless of the response's content type. Image decoding
retains the existing model limits.
Repository landing pages, directories, and issue pages keep normal scraping.

For extensionless paths, the agent first requests the URL path with `.md`
appended, preserving query parameters and dropping the fragment. It removes
trailing slashes before checking the last path segment. Paths with any file
extension, including `.html`, skip the probe. Existing `.md` URLs are read
directly without appending again. Extension detection decodes percent escapes;
dots in parent directories, query parameters, and fragments do not count.
A successful UTF-8 markdown or plain-text response bypasses Firecrawl. Failed
requests, non-200 responses, HTML, binary content, and empty responses fall back
to Firecrawl using the original URL supplied by the model. The probe has a
10-second timeout, five-redirect limit, and 64 MiB download limit. Image requests
retain their existing handling before this probe.
Direct markdown returns an explicit "summary not generated" value and an empty
image list; it does not extract media. Long direct results use the same JSON
temporary-file behavior as Firecrawl results, without a Convex transfer blob.

Fallback page scraping uses the official `@firecrawl/firecrawl-convex` component with
`markdown`, `summary`, `images`, `audio`, and `video` formats. The backend needs
`FIRECRAWL_API_KEY`; `CONTEXT_DEV_API_KEY` is no longer used. Audio and video are
returned as provider URLs, not downloaded media files.

`screenshot_url` captures a public page's viewport through Firecrawl's
`screenshot` format with `maxAge: 0` for a fresh capture. It shares `scrape_url`'s
image size limits. The tool is not registered for models without image support.
History stores the page URL, not the signed screenshot URL. Captures do
not share the user's browser session.

Image results from `parse_file`, `scrape_url`, and `screenshot_url` keep their
original bytes in the thread's local `parse_file/` directory. Convex stores only
the local path and image metadata. Both the initial tool response and later runs
read that saved copy and return native image content to the model. History does
not fetch the source again. Missing or invalid local copies produce a text notice;
models without image support receive a text notice instead of image content.

Scrape outputs above 40,000 serialized characters are saved as JSON in the host's temporary
directory, such as `/tmp` or Windows `%TEMP%`. The `markdown` output reports
`The scrape was too large to directly output. Instead, it has been saved to <file-path> for you to view.` These files have the operating system's
temporary-file lifetime. Convex transfer copies expire after one hour. The
`summary` field remains inline in both short and saved results. Summaries that
alone exceed the inline budget fail explicitly rather than being truncated.
HTML uses the cloud scraper through an
authenticated action. A HEAD request identifies image content types without
consuming page bodies. Image filename extensions cover servers without useful
HEAD responses. Downloaded image bytes are validated by signature; a mislabeled
image fails rather than issuing another GET through the scraper.
Image URLs that cannot be identified from HEAD or their filename follow the
normal scraping path. There is no explicit image mode.
Like shell commands and the former `parse_file` URL handling, the image and markdown probes
can reach local devices and private networks. It is not a network isolation
boundary. It does not attach browser cookies or provider credentials.

Document conversion accepts at most 64 MiB per call to bound
input buffering. Larger attachments remain available through shell tools. This
does not sandbox AnyDoc's memory or CPU use for compressed documents.

Firecrawl accepts at most 50 MB per uploaded file. Hosted calls are tied to the
existing executor job, do not retry the paid provider request automatically, and
keep their API key server-side. Temporary cloud inputs and results expire after
one hour; completed results are copied into the local parsed-file cache. A daily
age limit also collects unregistered cloud blobs left by lost upload responses
or action callbacks. Local
file access errors, image capability checks, safety limits, and cancellation do
not trigger hosted uploads. Cancellation stops the local wait, but cannot undo a
request already accepted by Firecrawl.

The server expires pending local uploads after 24 hours, sweeping on startup and
hourly while running. Submitted local thread attachments are not expired. If a pending
copy expires after submission but before caching, the agent downloads it from Convex.

Convex deletes attached file bytes when the owning thread's `lastMessageAt` is
older than one week. The owner is the thread that first attached the upload.
Assistant activity, reads, and downloads do not extend that window. Transcript metadata and
local copies remain. If an old file is unavailable both locally and in Convex,
the thread still opens and the agent asks for the file to be attached again.

The tool is available to every model. It returns image content only for models
whose gateway catalog entry supports images. Image decoding has separate safety
limits, which do not limit attachment uploads. Rebuilding history omits prior
image results when the selected model cannot accept them.

The agent currently offers command execution, command-session input, workspace
patching, skill loading (`read_skill`), web search, and web-page scraping. Every
tool call is wrapped in a durable executor-job record and observes run
cancellation while work is active.

Async tools share their timing policy through
`sprocket_workspace::async_tools`. New action tools should normalize their wait
with `YieldMode::Action`; poll tools use `YieldMode::Poll`. Use
`tools/async_tools.rs` for the matching provider schema and serde defaults, and
`execute_serialized_tool_job` for typed arguments and results in the existing
job lifecycle. Resource operations must observe the supplied cancellation token.
Cancelling a command operation stops waiting for input or output; the process stays available
through its thread session. Commands keep running after agent completion or
cancellation until they exit, reach an explicit timeout, are terminated, or the
server shuts down. Subsequent runs in the same thread reuse the sessions.
Every command returns a thread-scoped session ID, including commands that finish
within the initial wait. Session records, `output.log`, and `events.jsonl` are
stored under the Sprocket data directory. Only the event log is replicated to
Convex in ordered, retryable chunks; downloads reconstruct the raw output from
its ordered byte arrays. Downloaded logs live directly under
`command-logs/command-<sessionId>/`, alongside locally captured log directories.
Completed results remain pollable without an age or count limit after restarts
or from another machine. Remote queries download logs into the local data directory;
live command control requires the originating machine. Network outages leave
local records pending for retry, so another machine sees only previously synced data.
Once a running session's events are fully acknowledged, unchanged event lengths skip
cloud queries and writes. New bytes or completion resume synchronization; failed
and partial uploads remain pending. This idle tracking is in memory, so server
restart reconciles unsynced records with Convex again.
Running polls return incremental output; completed polls replay a bounded preview
of the full output, including bytes read by earlier runs, with full log paths.
If shutdown interrupts a command before its final status is saved, later polls
recover the log and report an interrupted, potentially incomplete result.
The transcript dashboard lists live commands without consuming output and offers
per-command termination.

For immediate polls, keep `ZeroPollCooldown` under the resource's observation
lock. Fetch current state before checking the cooldown so terminal results remain
available. Check before consuming pending output, and record success only after
the read succeeds. Failed, rejected, terminal, and positive-wait reads leave the
cooldown unchanged. Process I/O and question subscriptions retain their own wait
implementations.

Native delegation uses `spawn_subagent` for child creation,
`control_subagent` for sending follow-up prompts (`action: "send"`), stopping
descendant work and its entire descendant tree, or answering its questions, and
`poll_subagent` for lifecycle, filtered transcript pages, and pending questions.
Zero-wait actions return metadata only, without transcript entries or cursors.
Stop waits for the targeted run to reach a terminal status regardless of the
requested yield time, without waiting for replacement work in the same thread.
Tool status is the run status: queued, running, completed, failed, or cancelled.
Pending questions are returned separately. Spawn, send, and child listings return
thread IDs; internal activity, question deadlines, and transcript paths are omitted.
Positive polls wait for settlement or a question before reading a page,
even when the cursor points at older entries.
`list_subagents` lists immediate children in pages of 32; `list_subagent_models`
exposes compatible model settings. Child runs are independent of the caller's lifetime and never receive
payment tools. The delegation `timeoutMs` is persisted against the submitted run,
not the thread or subsequent runs. Stable tool-job submission identities recover
accepted child runs after a lost response instead of creating duplicates.
Sending to an actively running child fails with guidance to stop it or wait for
it to finish. Only pending cleanup of an ended run is waited out automatically.

Command execution and patch operations both run with the local Sprocket
process's permissions. Web search runs Exa through a Convex Workpool job.
Current agents orchestrate scraping locally and call an authenticated Firecrawl
request queue for pages. Provider keys (`EXA_API_KEY`, `FIRECRAWL_API_KEY`) stay
in the backend.

## Main areas

- `run.rs`: ownership, preparation, and finalization.
- `catalog.rs`: context window and automatic context handoff limits from `GET /api/v1/models`.
- `provider.rs`: gateway completion loop, transcript sink, and provider outcomes.
- `context_handoff.rs`: hidden in-run `handoff_context` turn followed by a fresh agent context. Provider usage only.
- `tools/`: model tools and durable job coordination.
- `convex.rs`: run-control communication.
- `types.rs`: history and context wire types.
- `hooks.rs`: durable tool-call assignments, dispatch correlation, and invalid-call recovery.

Changes to run state, history, cancellation, or tool shapes usually require a
matching Convex change.

## Rig 0.43 integration

The dependency is pinned to upstream `e02ddcc6` rather than the published 0.43
tarball, which leaks partial conversation content to stderr on invalid-tool
recovery. The pin includes the upstream removal and unified run errors without
the later item-shaped history API rewrite.

Provider construction uses native `DynModel<Completion>` and `Wire` APIs. Rig
owns Responses decoding, stream termination, reasoning seals, item replay, and
per-call optional usage. Gateway credentials refresh through transport middleware
rather than rebuilding completion models. Unknown usage does not overwrite the
last observed context size.

The completion boundary records assignments from the actual durable parts before
tool dispatch, including repaired calls. Every completion is checked for an
incomplete finish reason before tools execute. A terminal empty answer stays
empty; streamed commentary is not a substitute for a missing final response.

Sprocket retains its stateless request policy, SIWC connection pinning and tool
namespace, and durable context handoff. Rig's native ChatGPT provider targets a
different endpoint; its resumable runs do not replace versioned Sprocket
transcripts and idempotent external jobs. Gemini caching, ECS, other modalities,
and new provider/model constants do not affect the current Responses-only routes.
Replay metadata remains additive to the existing transcript format; see
`BACKWARDS_COMPATIBILITY.md` for legacy-reader behavior and removal gates.

## Validation

```sh
cargo test -p sprocket-agent
bun run test
prek run -a
```
