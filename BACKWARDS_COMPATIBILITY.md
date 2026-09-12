# Backwards compatibility

We ship breaking changes ahead of our users' installed clients and keep the old behavior working until those clients age out. That debt is easy to accumulate and easier to forget. This file lists every backwards-compatibility layer we currently ship, what it protects, how to remove it, and the signal that says removal is safe. When a removal PR merges, remove its entry from this document.

## Stored transcript work metadata

Historical transcripts may lack `threadTranscriptParts.work` and
`threadTranscriptStates.workThrough`. Opening a thread fills missing work metadata
with the Rust processor without changing its raw transcript bodies.

Keep support for missing metadata until every retained transcript has complete
membership and its checkpoint covers all parts. Remove only that fallback after
the gate passes; the processor remains responsible for new transcript parts.

## Native run lifecycle scheduling

New runs use `runLifecycle.checkRun` scheduled at the startup deadline or claim
expiry. `runExecutionStates` owns the scheduled function ID and generation so
timer updates do not invalidate thread-list subscriptions. Run finalization
cancels the check and still performs terminal cleanup in its transaction.

An hourly cron starts `migrateRunLifecycle`. It installs a native check for each
active run before clearing `runs.lifecycleWorkflowId` in the same transaction.
The existing Workflow then exits at its next `getWatchState` call. Completed runs
need no new check. The migration is idempotent and also repairs active runs with
no legacy workflow. To start the handoff immediately after deployment:

```sh
bunx convex run migrations:runNativeRunLifecycleMigration --prod
```

Keep the `workflow` component, its dependency and test registration, the optional
`lifecycleWorkflowId` field, and the legacy `watchRun`, `getWatchState`,
`abandonExpiredRun`, `reconcileTerminalPage`, and `finishLifecycle` functions until
the migration completes on every deployment, no run retains a workflow ID, and
no legacy workflow or scheduled workflow callback remains in progress. Preserve
the old workflow's step order until then so stored journals can replay. After
that gate passes, remove those functions, the component and dependency, and the
migration runner and cron together. Do not remove the external-tool workpools.

## Fast mode schema migration

Stored `threadRecords` and `runs` may use `serviceTier` with `standard` or
`fast`. Current code writes only `fastMode`. Convex keeps the stored field in
the schema while the migration runs and normalizes records read before the
backfill finishes. Current client APIs do not accept or return `serviceTier`.

An hourly cron starts the idempotent backfill after deployment. The manual
runner remains available for operator recovery:

```sh
bunx convex run migrations:runFastModeBackfill --prod
```

Remove `serviceTier` from the schema and the read normalization after the
backfill reports completion and every `threadRecords` and `runs` row has
`fastMode` with no remaining `serviceTier` field.

## Production rollout cleanup

PR #345 removed stored project tables, project references, run fields,
transcript migration state, message references, usage fields, and executor work
pool state before production data had been rewritten. The production deployment
that remained active after that failed rollout could still write some of those
fields. Cleaning existing rows immediately would race with those writers. This
release restores every known shape from that removal that still needs stored
data cleanup and ships the cleanup migrations in `convex/migrations.ts`.

The hourly cron calls `runProductionRolloutCleanupAutomatically`. Its first call
records a cleanup time 48 hours later. That delay exceeds the preceding
deployment's 36-hour gateway token lifetime and one-hour hosted parse lifetime,
so its writers have expired before cleanup starts. Once the delay passes, the
cron starts or resumes the migrations in order. It records completion after the
migrations component reports that every migration finished.

### Thread status

Production has historical `threadRecords` without `status`. Current run
lifecycle code writes the field, but the thread cache must still ingest old
rows. The schema and local cache parser therefore accept a missing value, and
`threadRecordToSummary` treats it as `completed`.

`backfillMissingThreadStatus` copies the latest run status onto each affected thread.
It marks a runless thread as `completed` rather than deleting user data. Remove
the optional schema and parser handling, and the summary default, after the
migration completes and a production scan finds no thread without `status`.

### Legacy projects and references

Production may still contain rows in `projects` and `projectConnections`, plus
`projectId` on `threadRecords`, `runs`, and `executorJobs`. Current code uses
`repositoryKey` and does not read or write these tables or references. Their
validators exist only so the stored rows survive schema validation.

`removeThreadRecordProjectId`, `removeRunLegacyFields`, and
`removeExecutorJobProjectId` unset all project references. The serial runner
then executes `deleteProjectConnections` before `deleteProjects`. Remove the
three optional fields and the two table definitions only after all five
migrations complete and production scans find no project reference, connection,
or project row. The project table deletions must remain last so no stored
reference outlives its target table.

### Run completion transport

The preceding schema accepted `runs.completionTransport` with either
`convex-action` or `gateway`, and the preceding production writer still stores
`gateway`. Current code neither reads nor writes this field. Both values remain
accepted so stored rows and writes made during the rollout validate.

`removeRunCompletionTransport` unsets the field. Remove it from the schema after
the migration completes and a production scan finds no run carrying it.

### Run catalog snapshots

Historical runs may contain `catalogVersion`, `contextWindowTokens`, and
`autoCompactTokenLimit`. Current code gets model limits from the gateway catalog
and does not read or write these stored snapshots. The fields remain optional
only so historical runs validate.

`removeRunLegacyFields` unsets all three fields. Remove them from the schema
after that migration completes and a production scan finds no run carrying any
of them.

### Usage ledger fields

The preceding production writer still dual-writes
`threadUsage.totalTokensProcessed`. Current code calculates processed tokens
from `threadUsageEvents` and the Aggregate component instead. The
`usageLedgerMigratedAt` field is a marker left by the completed ledger backfill;
current code does not read it. Both fields remain optional only to validate old
rows and writes made during the rollout.

`removeThreadUsageLegacyFields` unsets both fields. Remove them from the schema
after the migration completes and a production scan finds neither field.

### Numbered transcript migration marker

`threadTranscriptStates.migratedAt` was left by the completed numbered
transcript backfill. Current code does not read or write it, but production still
has rows carrying it.

`removeTranscriptStateMigratedAt` unsets the field. Remove it from the schema
after the migration completes and a production scan finds no transcript state
carrying it.

### Thread-message references

Historical runs and uploads may contain `runs.promptMessageId` and
`imageUploads.messageIds`. Prompts and attachment metadata now live in
`threadTranscriptParts`; current code does not read or write either old field.

`removeRunLegacyFields` unsets `promptMessageId`, and
`removeImageUploadMessageIds` unsets `messageIds`. Remove each field from the
schema only after its migration completes and a production scan finds no stored
value for that field.

### Executor work pool

The preceding production code writes `executorJobs.cloudWorkPool` for hosted
parse work and reads it to choose the cancellation pool. Current code no longer
reads or writes it, but an in-flight job from the preceding deployment can still
store `firecrawlScrape` while this release rolls out.

`removeExecutorJobCloudWorkPool` unsets the field. Remove it from the schema
after the migration completes, all jobs started by the preceding deployment
have settled, and a production scan finds no executor job carrying it.

The cleanup runs automatically. `runProductionRolloutCleanup` remains available
for operator recovery, but it must not be called before the scheduled
`notBefore` time in `migrationSchedules`:

```sh
bunx convex run migrations:runProductionRolloutCleanup '{"dryRun":true}' --prod
bunx convex run migrations:runProductionRolloutCleanup --prod
```

Keep the migration definitions until the runner reports completion. A later PR
may tighten the schema and remove the read fallbacks only after the production
scans described above pass. That PR may also remove the cleanup cron and its
`migrationSchedules` row and table.

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

## Run execution state

`runExecutionStates` owns claim IDs, lease expiry, completion attempt numbers, and
the active tool job. The optional copies on `runs` are read only when no execution
state exists. New runs create both records in one transaction. The first execution
write on an older run moves its fields in the same transaction, and
`migrations:runExecutionBackfill` backfills the remaining records automatically.
`getContext` returns only the current agent's run snapshot. Execution checks
load the separate state; old caller response shapes are not preserved.

Remove the legacy `runs` fields and fallback after `backfillRunExecution` completes
on every deployment and all stored runs have execution state.

New runs stay `running` while tools execute. `awaiting_executor` remains accepted
in schema and client validators for old database records and local transcript or
thread caches. The backfill rewrites that status on runs and thread records.
Finalization treats `running` and `awaiting_executor` as aliases while still
checking the claim and lease. Keep the alias until `awaiting_executor` is removed
entirely, after the backfills complete and persisted local caches no longer
require it.

## Retired completion stream state

Current code neither reads nor writes `runs.completionStreamStateId` or
`completionStreamStates`. `completionActor` returns identity and lease fields,
without the retired `streamSequence` and `streamAttemptId` response fields. The
old live-token merge endpoint is gone. Current completion attempts still use
`runExecutionStates`, and completed turns still use `threadTranscriptParts`.

The hourly cron starts `migrations:runCompletionStreamCleanup`. It first removes
all run pointers, then deletes stream-state rows in batches, including orphans.
The manual runner can resume failed cleanup. This migration is independent of
the older production rollout cleanup, which may have already finished.

Keep the optional pointer and table schema until both migrations complete on
every deployment and scans find no run pointer or stream-state row. Then remove
those schema definitions, the migration functions, and their cron together.
No Sprocket data-directory formats or readers change in this cleanup.
