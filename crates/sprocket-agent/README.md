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
not share the user's browser session; use browser tools for signed-in pages.

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
- `hooks.rs`: tool-call correlation, invalid-call handling, and OpenAI additional params.

Changes to run state, history, cancellation, or tool shapes usually require a
matching Convex change.

## Validation

```sh
cargo test -p sprocket-agent
bun run test
prek run -a
```
