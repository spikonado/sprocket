# Backwards compatibility

## CLI authentication and run control

CLI clients send their exact semantic release version to local `/api/cli/*`
endpoints. The local server rejects every mismatch, including canary identifiers
and dev commit hashes, so a newly installed CLI cannot reuse a stale server.
Native login and agent-run endpoints keep their request formats and interactive
tool set. Finalization always returns the structured result; the
`transcriptProtocol` and `includeOutput` arguments were removed.

CLI discovery and bootstrap proofs bind to a random server-process ID. The CLI
never sends the reusable pairing credential over HTTP. CLI sessions stay in
memory and cannot resume after a server restart. Bound persisted browser
sessions keep working.

Session records require the `localBrowser` field. Session files written before
remote HTTPS support fail to parse and start empty; the user signs in again.

Finalization always returns the structured `{accepted, outcome}` result. The
response does not contain model text; the CLI reads that from the local
transcript cache.

Profiles without a credential-store selection continue using the existing
deployment-and-data-directory-scoped keyring entry. No credentials are copied to
file storage automatically. The keyring default has no removal gate; it remains
the default storage backend.

Older apps do not subscribe to `/api/auth/changes`; their existing session-token
reads still observe the shared login. Keep those endpoints until all supported
installed apps use the session-change subscription. Native tokens remain
restricted to the existing local-app endpoint; CLI control uses local pairing
sessions and never returns refresh tokens.

New servers take an exclusive data-directory lock. Separate profiles must use
separate data directories.

Local servers call `threads:settle`, `threads:unsettle`, `threads:rename`, and
the live `threads:rekeyRepository` directly. The `*ForLocalCache` aliases were
removed.

We ship breaking changes ahead of our users' installed clients and keep the old behavior working until those clients age out. That debt is easy to accumulate and easier to forget. This file lists every backwards-compatibility layer we currently ship, what it protects, how to remove it, and the signal that says removal is safe. When a removal PR merges, remove its entry from this document.

## Local project attachments

Project attachment records require `attachmentKey` in the profile's
`project-attachments.json`. Files written before PR #392 fail to parse; the
user re-attaches their projects.

## Completed migrations (removed 2026-09)

The production-rollout cleanup (`production-rollout-cleanup-2026-09`) and the
write-time transcript-section migration (`transcript-write-time-sections-v1`)
both report completion on every deployment, and production scans find no
remaining legacy rows. Their migration definitions, crons, the migrations
component wiring, and the `migrationSchedules` table were removed, and the
schema was tightened accordingly:

- `projects` and `projectConnections` tables, and every `projectId` reference
  on `threadRecords`, `runs`, and `executorJobs`.
- Required `threadRecords.status` (backfilled from the latest run status).
- `runs.completionTransport`, `catalogVersion`, `contextWindowTokens`,
  `autoCompactTokenLimit`, and `promptMessageId`.
- `threadUsage.totalTokensProcessed` and `usageLedgerMigratedAt` (processed
  tokens come from `threadUsageEvents` and the Aggregate component).
- `threadTranscriptStates.migratedAt`.
- Required `threadTranscriptParts.work` (the membership read fallback is gone;
  every part carries its assignment).
- Required `threadTranscriptWorkSections.sectionOrdinal` and `displayOrder`.
- `imageUploads.messageIds`.
- `executorJobs.cloudWorkPool`.
- `work.processed` in transcript work memberships.

Still retained from that era: `threadTranscriptStates.workThrough` (no
migration ever unsets it), section `linkedParts`, and the
`threadTranscriptMemberships` entry rows that current section writes use for
idempotent retries.

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
it fail argument validation.

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
local transcripts load. Live jobs carrying a URL fail argument validation.

Remove the URL variants after those jobs and local replicas have aged out or
been rewritten.

## Stored transcript formats

### Attachment metadata and cache layout

Historical prompt attachments may contain `imageUploadId`; current writes use
only `storageId`. Convex readers accept the old field and remove it from
projected responses. The local user-level blob directory fallback was removed;
new uploads use only the thread directory.

Remove the Convex reader after old Convex rows have aged out or been rewritten.

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

## Retired Convex functions

The upgrade-message stubs for retired Convex functions were removed
(`agentRuntime.createRun/finalizeRun/reopenRun/saveContextCompaction`,
`chat.latestRunForThread`, `completion.*`, `messages.*`, `modelCatalog.get`,
`projects.*`, `threads.create/listMine/archive/restore/rekeyRepository`,
`uiPreferences.setLastThread/setPaymentsEmail`,
`webTools.scrapeUrl/webSearch/scrapeForTool/screenshotForTool`,
`browserAgent.*`, `machineSessions.*`, `machines.register`). Released clients
that still call them get a function-not-found error instead of the upgrade
message. The `transcriptProtocol` and `includeOutput` arguments were removed
from the remaining agent functions for the same reason.
