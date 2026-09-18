# Backwards Compatibility

We ship breaking changes ahead of our users' installed clients and keep the old behavior working until those clients age out. We also ship breaking changes to Convex schemas with migrations. That debt is easy to accumulate and easier to forget. This file lists every backwards-compatibility layer we currently ship, what it protects, how to remove it, and the signal that says removal is safe. When a removal PR merges, remove its entry from this document.

## Convex Backwards Compatibility 

### Current Migrations

`convex/migrations.ts` ships backfills for legacy stored fields that current code never writes.
The hourly cron runs `runLegacyCompatBackfillAutomatically`, which records completion in `migrationSchedules` under `legacy-compat-backfill-2026-09` once the migrations component reports every migration finished.
In serial order: `removeTranscriptStateWorkThrough`,
`removeMandateSetupUserEmail`, `normalizeScrapeUrlResults`,
`backfillExecutorJobToolInvocationId`, `migrateToolPartJobIds` (resolves each
part's job, so it runs after the job backfill),
`normalizeTranscriptCompletionTiming`, `stripStoredAttachmentImageUploadIds`,
and `convertContextHandoffCutoffs` (resolves each run-ID cutoff to the last
covered part number).

After the runner reports completion and production scans confirm no row carries
the old fields, a later PR may: drop `workThrough`, mandate `userEmail`, scrape
`truncated` from the schema and validators; require
`summary`/`images` on scrape results; require `toolInvocationId` on executor
jobs and transcript tool parts and drop `jobId` and its pairing fallback;
normalize or require stored completion timing; drop stored `imageUploadId`; drop
`contextSummaryThroughRunId` and the reasoning reload filter. That PR may also
remove the backfill cron and its `migrationSchedules` row and table. Dropping
`linkedParts` waits on rewriting preserve-on-retry section writes so they no
longer treat the field as the pre-counted summary marker.

### Outdated Executor jobs

No lossless migration exists for retired tool kinds and their payload/result
variants, `parse_file` URL sources, legacy command results, mandate status
descriptions, or `streamId` on older completion bodies, so those validators stay
permanently to keep conversation history readable.

#### Historical artifact tools

The artifact API no longer exposes the old create and update endpoints, and
`beginToolJob` rejects their retired names. Stored executor jobs still validate
the old artifact tool names, payloads, and results so existing conversation
history remains readable. There is no lossless rewrite into current tool shapes,
so those validators stay permanently.

#### Historical Browserbase tools

Browserbase endpoints and provider code are gone. Stored executor jobs may
still use `browser_observe`, `browser_act`, or `browser_extract`, along with
their old payload and result shapes. Their validators remain so conversation
history can load. There is no lossless rewrite into current tool shapes, so
those validators stay permanently.

#### Mandate setup email

Mandate setup jobs written through v0.3.2 may contain `payload.userEmail`.
`vMandateSetupPayload` accepts that field for stored jobs. Live calls carrying
it fail argument validation. `removeMandateSetupUserEmail` drops the field from
stored payloads.

Early `mandate_status` results may also omit `description`, so the stored result
validator keeps that field optional. Current status calls always return it.
There is no source to backfill the missing descriptions from, so that variant
stays permanently.

#### Web tool result fields

Stored `scrape_url` results may contain `truncated`. Results written before the
Firecrawl integration may omit `summary` and `images`. The validators accept
both shapes so executor history and local JSONL transcripts remain readable.
`normalizeScrapeUrlResults` drops `truncated` and backfills the Firecrawl
default summary with an empty image list.

#### Hosted parse files

Historical `parse_file` jobs and results may identify their source with a URL.
The stored payload and result validators retain that shape so job history and
local transcripts load. Live jobs carrying a URL fail argument validation.
Only the file bytes could turn a URL source into a path source, so those
variants stay permanently.

### Stored transcript formats

#### Attachment metadata and cache layout

Historical prompt attachments may contain `imageUploadId`; current writes use
only `storageId`. Convex readers accept the old field and remove it from
projected responses. The local user-level blob directory fallback was removed;
new uploads use only the thread directory. `stripStoredAttachmentImageUploadIds`
removes the field from stored rows.

Remove the Convex reader after old Convex rows have aged out or been rewritten.

#### Completion timing

Historical completion items and local JSONL records may omit `startedAt` and
`completedAt`. Readers preserve those records without inventing timing. Current
Convex writes normalize missing values to `null`, and
`normalizeTranscriptCompletionTiming` backfills `null` onto stored items.

Historical completion bodies may omit `streamId`, and older local transcript
parts may omit `createdAt`. Readers leave stream identity and tool-event timing
unknown when those fields are absent. Stream identity cannot be reconstructed
after the fact, so that variant stays permanently. Input validators may remain
optional when current model providers do not supply a timestamp.

#### Tool invocation IDs

Historical tool parts use `jobId` and source keys of the form `tool:<jobId>`.
Current parts use `toolInvocationId` and phase-specific source keys. Readers use
`jobId` as the fallback pairing key, and `executorJobs.toolInvocationId` remains
optional for old jobs. `backfillExecutorJobToolInvocationId` fills the job
field from the job document id, and `migrateToolPartJobIds` resolves each
part's `jobId` through its job and then drops it.

#### Context handoff cutoffs

Historical summaries may use `contextSummaryThroughRunId`. Current writes use
the more precise `contextSummaryThroughPartNumber`; transcript reads retain the
run-ID fallback so old summaries still skip their covered prefix.
`convertContextHandoffCutoffs` resolves each run-ID cutoff to the last covered
part number.

When any summary exists, history reload also omits stored encrypted reasoning.
Old run-level summaries can replace context that the reasoning depended on, so
replaying that ciphertext is unsafe. The reasoning filter can be removed once
no row retains only `contextSummaryThroughRunId`.
