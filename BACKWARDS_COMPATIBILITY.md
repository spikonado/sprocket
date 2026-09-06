# Backwards compatibility

This file lists shims we still ship. When a removal PR merges, delete its
entry. Age-out is a prod check for stored rows, or an explicit decision that
a retired function name can disappear.

Current as of 2026-09-06.

## Transcript projection API

Assistant text, reasoning, and tool calls accept optional `startedAt` and
`completedAt` timestamps. Released agents and old stored completions lack them.
The UI omits durations when section boundaries are unknown rather than inferring
them from the run start or transcript sequence numbers. New local replicas also
retain the transcript record creation time for tool-event timing. Existing JSONL
records remain readable without it; historical reasoning timing cannot be recovered.
New completion writes normalize missing timestamps to explicit `null`, including
writes from older agents. `backfillTranscriptTiming` in `convex/migrations.ts`
does the same for stored completion items without changing known timestamps.
It is included in the default migration runner. After deploying the nullable
validators, write normalization, and null-aware UI, run from `apps/web`:

```sh
bun convex run migrations:runTranscriptTiming
```

Pass `'{"dryRun":true}'` to preview one batch without writes.
Use `--prod` for the production deployment. This is a resumable, idempotent
backfill; verify its status is complete in the migrations component before
tightening the stored validators to `v.union(v.number(), v.null())`.
No historical timing is invented and untimed history need not be deleted.
Keep optional input validators separate for supported agents that omit timing.
Removing optional timing from the shared wire validators additionally requires
all supported producers to emit explicit nulls and old JSONL replicas to be
normalized at the read boundary. Tool results are projected, not stored as
completion items, so their wire validator has that separate removal gate.
Both Convex transcript read endpoints omit null timestamps for released agents
and UIs; stored records still contain explicit nulls. The local projected-message
API also omits nulls from replicas populated before that read adapter was deployed.
Remove these adapters once all supported consumers handle explicit nulls, keeping
stored and wire validators separate until then.
The projected `runStartedAt` field remains numeric for released clients, with `0`
meaning unknown instead of a sequence number. Remove it once supported clients no
longer read it; the current section timer uses assistant-part timestamps.

PR #295 keeps `/api/transcript/page` returning raw `parts` for released clients.
The projected-message client uses `/api/transcript/messages`; the legacy route
reads the same complete message window and returns its original parts. The
JSONL replica format is unchanged. Remove the legacy route after all supported
clients use the projected-message endpoint.

## Stored schema

Optional fields, dual-writes, and leftover tables that keep documents written
under an older schema valid. Current clients do not depend on these shims.
Fold a rewrite into the PR that introduces the next breaking schema change
instead of leaving a coerce path behind.

`@convex-dev/migrations` stays mounted so future one-off jobs can use
`migrations.runner()`. Completed series members are gone.

### Thread status backfill

`threadRecords.status` is temporarily optional while
`migrations:backfillThreadStatus` populates it from each thread's latest run
and deletes legacy runless threads and their usage row. Cache consumers accept
the field as absent only while this migration is rolling out.

Deploy this compatibility schema and code, run the migration to completion,
verify every thread has a status, then make the field required and remove the
optional cache handling in a follow-up deployment.

### 1. Legacy project tables and references

The `projects` and `projectConnections` tables stay in the schema so existing
rows and leftover `projectId` fields validate. Threads store `repositoryKey`
(still optional in the validator). `projectId` on `threadRecords` / `runs` /
`executorJobs` is optional leftover. Local `project-attachments.json` rows
that still have `projectId` are rewritten on load to `workspacePath` +
`repositoryKey`. Older clients that still call `projects.listMine` /
`upsertSelected` / `heartbeatAttached` get the unsupported-client update
error.

The repository-key backfill and `projectId` unset passes are done. Remove the
leftover tables and `projectId` fields after a later unset rewrite, then drop
`repositoryKey` optionality.

### 2. Mandate job payloads still accept `userEmail`

Up to v0.3.2, mandate setup stored the caller email on
`executorJobs.payload`. `vMandateSetupPayload.userEmail` stays optional so
those rows validate. Live callers that still send `userEmail` are rejected as
an unsupported client (see below).

Remove by dropping the field after a prod sweep shows no stored mandate-setup
jobs carrying it.

### 3. Aggregate usage ledger leftovers

Processed-token totals live in `threadUsageEvents` plus a namespaced
Aggregate. `getThreadUsageValues` reads that sum. `recordThreadUsageEvent`
still dual-writes `threadUsage.totalTokensProcessed` as a denormalized cache.

`usageLedgerMigratedAt` is unused leftover after the backfill. It is not a
read gate.

Remove the dual-write (and then the required field) after an unset rewrite.
Drop `usageLedgerMigratedAt` after a separate unset, or in the same rewrite.

### 4. Historical `runs.completionTransport`

Stored runs may still say `convex-action`. New inserts are `gateway`. The
field stays optional so those rows validate.

Remove the `convex-action` union member after a rewrite or a prod check shows
none remain.

### 5. Catalog snapshot fields on `runs`

Earlier gateway work stored `catalogVersion`, `contextWindowTokens`, and
`autoCompactTokenLimit` on new runs. Current inserts leave those unset. The
agent reads context budget from `GET /api/v1/models`; `getContext` returns
`0` when the snapshot is missing.

Keep the optional fields so rows that still have them validate. Unset them in
a later rewrite, then drop them from the schema.

### 6. Numbered transcript `migratedAt`

`threadTranscriptStates.migratedAt` is leftover after the numbered-transcript
backfill. Current writes do not set it.

Remove after an unset rewrite, then drop it from the schema.

### 7. Transcript tool `jobId`

Sources: append-only tool progress events.

New tool transcript parts pair by `toolInvocationId` and source keys
`tool:<id>:started` / `tool:<id>:finished`. They do not write `tool.jobId`.
Stored parts from before this change still carry `jobId` (and the un-suffixed
`tool:<jobId>` source key). Readers keep using `jobId` as a fallback pairing
key until those rows are gone.

`executorJobs.toolInvocationId` is optional for the same reason: in-flight jobs
created before this change have no stored id, and finished-event writes fall
back to the job document id.

Remove `vTranscriptToolBody.jobId` after a rewrite copies `jobId` onto
`toolInvocationId` where missing and unsets `jobId`. Drop executor-job
optionality after a production scan finds no jobs without `toolInvocationId`.

Safe when a prod check shows zero transcript tool parts carrying `jobId`.

### 8. Legacy installation identity and machine metadata

Local servers now persist a versioned `installation.json`. On first launch
after upgrade they preserve the UUID from the legacy plain-text
`installation-id` file and write the JSON identity. The old file is left in
place for rollback safety but is no longer read once the JSON file exists.

`machines.platformVersion` and `machines.hostname` are optional so
rows and released agents without the expanded normalized machine metadata
remain valid. Remove their optionality after all supported agents send both
fields and a production scan finds no machine rows missing either one.

Delete legacy `installation-id` files only after all supported installations
have launched a JSON-aware server and rollback to an older release is no
longer supported.

### 9. Thread-message references

Prompts and attachment metadata now live in `threadTranscriptParts`; current
code neither reads nor writes `threadMessages`. The table is no longer in the
validated schema. Historical `runs.promptMessageId` and
`imageUploads.messageIds` remain optional so existing documents validate.
Gateway run creation still returns a synthetic `promptMessageId` for released
agents that require the response field; current code does not consume it.

`migrations.removeRunPromptMessageIds` and
`migrations.removeImageUploadMessageIds` unset both fields. Remove the pinned
migration runner, its cron, and both schema fields once both migrations report
`success` and production scans find no remaining values. Historical documents
in the now-unvalidated `threadMessages` table may be deleted independently.

### 10. Legacy context compaction cutoff

Released agents still call `saveContextCompaction`, which bills through the
`compaction:` usage event and stores `contextSummaryThroughRunId` (last fully
covered prior run). Transcript reads keep that run-id lookup so old rows skip
the covered prefix. A legacy persist clears `contextSummaryThroughPartNumber`
so a coarser run-id cutoff cannot sit under a leftover precise boundary.

New agents call `saveContextHandoff` and store
`contextSummaryThroughPartNumber`, the inclusive last covered transcript part
(`-1` when the prefix is empty). Reads prefer the part-number cutoff when it
is present so a mid-run handoff does not replay work that a run-scoped cutoff
would leave in context. Parts are not deleted; UI paging still starts at part 0. `saveContextHandoff` unsets `contextSummaryThroughRunId`.

Handoff usage is recorded by `recordContextUsage`, not by `saveContextHandoff`.

Agents still omit encrypted reasoning on reload when a summary exists, because
legacy compaction can leave reasoning tied to replaced context. Remove this
reload filter when legacy writers have aged out and all cutoffs are precise.

`migrations.backfillContextSummaryThroughPartNumber` copies a run-id cutoff
onto `contextSummaryThroughPartNumber` when that field is missing. It is in
the default `migrations:run` cron. From `apps/web`:

```sh
bun convex run migrations:run
```

Use `--prod` for the production deployment. Leave the run-id fallback in
place while released agents still write `saveContextCompaction`.

Remove `saveContextCompaction`, the run-id field, and the fallback read after
all supported agents call `saveContextHandoff`, the backfill reports `success`,
and a production scan finds no rows that still have
`contextSummaryThroughRunId` without `contextSummaryThroughPartNumber`. Unset
remaining run-id values in that same PR, then drop the field.

## Client APIs

### Local sessions created before account binding

Persisted local sessions created before native WorkOS account binding have no
`userId`. They continue to deserialize so users receive an explicit sign-in
error instead of losing the pairing credential, but account-scoped routes
reject them until the user signs in again. New desktop login callbacks bind
the authenticated WorkOS user to the local session that started the flow.

Remove `SessionRecord.user_id` optionality after all supported installations
have completed a native sign-in on a version that writes the binding.

Released desktop/CLI builds that still call retired Convex functions get a
`ConvexError`: "This Sprocket version is no longer supported. Update to the
latest Sprocket release." Production does not mask that text.

How that sentence reaches the user:

- Installed desktop UI already surfaces Convex query failures in the
  transcript banner. Retired queries such as `messages.listHistoryForThread`
  fail as soon as an old UI opens a thread.
- Current UI prefers ConvexError `.data` (`convexClientErrorMessage`) so the
  banner is just that sentence.
- Local agent/CLI prints it on stderr (`sprocket-server: agent run failed`)
  and stores it on `runs.lastError` when a run already exists.

There is no behavior shim for those clients. The functions below exist only
to deliver the update sentence; current code never calls them.

| Function                                                       | Old caller                                                |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| `agentRuntime.createRun`                                       | Agent run creation before the gateway path                |
| `agentRuntime.mergeAssistantStreamEvents`                      | Agents that streamed tokens onto `threadMessages`         |
| `agentRuntime.reopenRun`                                       | Desktop UI that reopened a failed run in place            |
| `chat.latestRunForThread`                                      | UI lifecycle from the latest Convex run document          |
| `completion.complete` / `completion.summarize`                 | Convex-hosted model calls                                 |
| `messages.listHistoryForThread` / `messages.listLiveForThread` | UI transcript from Convex                                 |
| `modelCatalog.get`                                             | Static bundled catalog                                    |
| `threads.listMine`                                             | UI thread list from Convex                                |
| `threads.rename` / `archive` / `restore` / `rekeyRepository`   | UI thread commands that mutated Convex directly           |
| `uiPreferences.setLastThread` / `setPaymentsEmail`             | Session restore and mandate email writes                  |
| `webTools.scrapeUrl` / `webTools.webSearch`                    | Direct tool actions; current agents enqueue executor jobs |
| `payments` mandate setup with `userEmail`                      | Agents that sent the customer email themselves            |
| `machineSessions.register` / `heartbeat` / `end` / `listMine`  | Local servers that registered process sessions            |

Remove a stub when we are willing to let that function name disappear (old
installs then see a missing-function error instead of the update sentence).

### Live leftover name: `transcript.ensureMigrated`

Current desktop/server still call this (`transcript_client.rs` /
`transcript_watch.rs`). It only ensures `threadTranscriptStates` exists. It
does not read `threadMessages` and is not an unsupported-client stub.

Remove after rust/desktop stop calling it, then delete the Convex export.

### Local thread commands

Current UI sends rename, archive, restore, repository-rekey, and cancellation
through the authenticated local Rust API. The public Convex names those older
bundles called (`threads.rename`, `archive`, `restore`, `rekeyRepository`,
`threads.listMine`, `chat.latestRunForThread`, `agentRuntime.reopenRun`) are
unsupported-client stubs.

The local command routes call `threads.renameForLocalCache`,
`archiveForLocalCache`, `restoreForLocalCache`, and
`rekeyRepositoryForLocalCache`. These variants return the authenticated user
and affected repository/category metadata so Rust can refresh the cache before
acknowledging a command. Remove the `ForLocalCache` variants only when Rust no
longer needs synchronous cache-refresh metadata from Convex.

Current thread navigation reads the Rust-owned summary cache. Current
lifecycle UI reads `chat.selectedThreadLifecycle`. The local `/threads/lifecycle`
route is a one-shot command-time relay, not a replacement subscription. Move
lifecycle reads behind Rust only if Rust gains an equivalent ordered reactive
stream.

## Removal checklist

1. Confirm the gate with prod numbers (schema) or an explicit decision that
   the function name can vanish (clients).
2. Land any data rewrite before shrinking validators.
3. Delete the shim, validator changes, and tests that only pin compat
   behavior, in one PR.
4. Remove the entry from this document.
