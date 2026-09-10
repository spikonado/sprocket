# Backwards compatibility

We ship breaking changes ahead of our users' installed clients and keep the old behavior working until those clients age out. That debt is easy to accumulate and easier to forget. This file lists every backwards-compatibility layer we currently ship, what it protects, how to remove it, and the signal that says removal is safe. When a removal PR merges, remove its entry from this document.

Current as of 2026-09-10.

## Stored executor jobs

### Historical artifact tools

The artifact API no longer exposes the old create and update endpoints, and
`beginToolJob` rejects their retired names. Stored executor jobs still validate
the old artifact tool names, payloads, and results so existing conversation
history remains readable. Remove those validators when no executor jobs contain
the retired names.

### Historical Browserbase tools

Browserbase endpoints and provider code are gone. Stored executor jobs may
still use `browser_observe`, `browser_act`, or `browser_extract`, along with
their old payload and result shapes. Their validators remain so conversation
history can load.

Remove these validators when no executor jobs contain the retired Browserbase
tool names.

### Mandate setup email

Mandate setup jobs written through v0.3.2 may contain `payload.userEmail`.
`vMandateSetupPayload` accepts that field for stored jobs. Live calls carrying
it fail through `unsupportedClient()`.

Early `mandate_status` results may also omit `description`, so the stored result
validator keeps that field optional. Current status calls always return it.

Remove these variants after a production scan finds no mandate setup jobs with
`userEmail` and no mandate status results without `description`.

### Web tool result fields

Stored `scrape_url` results may contain `truncated`. Results written before the
Firecrawl integration may omit `summary` and `images`. The validators accept
both shapes so executor history and local JSONL transcripts remain readable.

Remove these variants after the old jobs and local replicas have aged out or
been rewritten.

### Hosted parse files

Historical `parse_file` jobs and results may identify their source with a URL.
The stored payload and result validators retain that shape so job history and
local transcripts load. Live jobs carrying a URL fail through
`unsupportedClient()`.

Remove the URL variants after those jobs and local replicas have aged out or
been rewritten.

## Stored transcript formats

### Local transcript state

Early local `state.json` files may omit `downloadedRanges` or `stale`. The
replica reader supplies the empty or false value. Prompt bodies that predate
attachments may omit `imageUploads`; readers treat them as having no
attachments.

Remove these defaults after old local transcript caches have aged out or been
rewritten.

### Attachment metadata and cache layout

Historical prompt attachments may contain `imageUploadId`; current writes use
only `storageId`. Convex and local JSONL readers accept the old field and remove
it from projected responses.

Old local attachment bytes may live in the user-level blob directory. Reading
one copies it into the thread's `attachments/<storageId>/` directory before
returning its path. New uploads use only the thread directory.

Remove these readers after old Convex rows and local transcript caches have
aged out or been rewritten.

### Completion timing

Historical completion items and local JSONL records may omit `startedAt` and
`completedAt`. Readers preserve those records without inventing timing. Current
Convex writes normalize missing values to `null`.

Historical completion bodies may omit `streamId`, and older local transcript
parts may omit `createdAt`. Readers leave stream identity and tool-event timing
unknown when those fields are absent.

Remove optional stored timing only after old rows and local replicas have aged
out or been rewritten. Input validators may remain optional when current model
providers do not supply a timestamp.

### Tool invocation IDs

Historical tool parts use `jobId` and source keys of the form `tool:<jobId>`.
Current parts use `toolInvocationId` and phase-specific source keys. Readers use
`jobId` as the fallback pairing key, and `executorJobs.toolInvocationId` remains
optional for old jobs.

Remove this fallback when a production scan finds no transcript tool parts with
`jobId` and no executor jobs without `toolInvocationId`.

### Context handoff cutoffs

Historical summaries may use `contextSummaryThroughRunId`. Current writes use
the more precise `contextSummaryThroughPartNumber`; transcript reads retain the
run-ID fallback so old summaries still skip their covered prefix.

When any summary exists, history reload also omits stored encrypted reasoning.
Old run-level summaries can replace context that the reasoning depended on, so
replaying that ciphertext is unsafe.

Remove the fallback after every summarized thread has a part-number cutoff and
no row retains only `contextSummaryThroughRunId`. The reasoning filter can be
removed at the same point.

## Unsupported client errors

Released clients that call retired Convex functions get a `ConvexError` with:

> This Sprocket version is no longer supported. Update to the latest Sprocket release.

These exports and retired argument branches exist only to return that message.
Current code does not use them.

| Function                                                       | Retired caller                                          |
| -------------------------------------------------------------- | ------------------------------------------------------- |
| `agentRuntime.createRun`                                       | Agent run creation before the gateway path              |
| `agentRuntime.finalizeRun`                                     | User-authenticated agent run finalization               |
| `agentRuntime.mergeAssistantStreamEvents`                      | Agents that streamed tokens onto `threadMessages`       |
| `agentRuntime.reopenRun`                                       | Desktop UI that reopened a failed run in place          |
| `agentRuntime.saveContextCompaction`                           | Agents that stored run-bounded context summaries        |
| `chat.latestRunForThread`                                      | UI lifecycle from the latest Convex run document        |
| `completion.complete` / `completion.summarize`                 | Convex-hosted model calls                               |
| `messages.listHistoryForThread` / `messages.listLiveForThread` | UI transcript from Convex                               |
| `modelCatalog.get`                                             | Static bundled catalog                                  |
| `projects.listMine` / `upsertSelected` / `heartbeatAttached`   | Cloud project selection and heartbeat                   |
| `threads.create` / `listMine`                                  | Direct thread creation and UI listing through Convex    |
| `threads.rename` / `archive` / `restore` / `rekeyRepository`   | UI thread commands that mutated Convex directly         |
| `uiPreferences.setLastThread` / `setPaymentsEmail`             | Session restore and mandate email writes                |
| `webTools.scrapeUrl` / `webTools.webSearch`                    | Direct tool actions before executor jobs                |
| `webTools.scrapeForTool` / `screenshotForTool`                 | Blocking Firecrawl actions before request subscriptions |
| `browserAgent.interact` / `browserAgent.screenshot`            | Blocking browser actions before request subscriptions   |
| `agentRuntime.beginToolJob` with `parse_file.payload.url`      | Agents that sent remote files to the hosted parser      |
| `payments` mandate setup with `userEmail`                      | Agents that sent the customer email themselves          |
| `machineSessions.register` / `heartbeat` / `end` / `listMine`  | Local servers that registered process sessions          |
| `machines.register`                                            | Local servers without typed registration retries        |

Remove a stub when its retired function name no longer needs to return the
upgrade message.
