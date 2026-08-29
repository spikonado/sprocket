# Backwards compatibility

This file lists shims we still ship. When a removal PR merges, delete its
entry. Age-out is a prod check for stored rows, or an explicit decision that
a retired function name can disappear.

Current as of 2026-08-29.

## Stored schema

Optional fields, dual-writes, and leftover tables that keep documents written
under an older schema valid. Current clients do not depend on these shims.
Fold a rewrite into the PR that introduces the next breaking schema change
instead of leaving a coerce path behind.

`@convex-dev/migrations` stays mounted so future one-off jobs can use
`migrations.runner()`. Completed series members are gone.

### 1. Legacy fields on `uiPreferences`

Source: #187, plus later catalog/payments work.

Optional fields kept so existing rows validate. Nothing current writes them:

- `uiPreferences.lastThreadId` — restore uses `pickThreadToRestore`
- `uiPreferences.paymentsEmail` — mandate setup uses the WorkOS identity email

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

Remove the remaining `uiPreferences` fields by unsetting each in a one-off
backfill, then dropping them from `convex/schema.ts`.

Safe when a prod check shows zero rows carrying the field.

### 2. Retired model IDs on stored selections

Sources: #191, #192, and later catalog drops. Retired ids:
`gpt-5.6-terra`, `gpt-5.6-luna`, `grok-4.5`, `stealth/ox-alpha`,
`deepseek-v4-pro`, `deepseek-v4-flash`. They survive on
`threadRecords.selectedModel` and `runs.selectedModel`.

`coercePersistedModelId` / `coercePersistedSelection` map known ids at read
time (`agentRuntime.getContext`, stale-run recovery, thread open). The
rewrite passes that copied those replacements onto stored rows are done.

Remove the coerce helpers, `retiredModelIds`, and `retiredModelReplacements`
once we drop this known-id map. Keep `selectedModel` as `v.string()`.

Every later catalog drop should ship its own rewrite in the same PR.

### 3. Mandate job payloads still accept `userEmail`

Up to v0.3.2, mandate setup stored the caller email on
`executorJobs.payload`. `vMandateSetupPayload.userEmail` stays optional so
those rows validate. Live callers that still send `userEmail` are rejected as
an unsupported client (see below).

Remove by dropping the field after a prod sweep shows no stored mandate-setup
jobs carrying it.

### 4. Aggregate usage ledger leftovers

Processed-token totals live in `threadUsageEvents` plus a namespaced
Aggregate. `getThreadUsageValues` reads that sum. `recordThreadUsageEvent`
still dual-writes `threadUsage.totalTokensProcessed` as a denormalized cache.

`usageLedgerMigratedAt` is unused leftover after the backfill. It is not a
read gate.

Remove the dual-write (and then the required field) after an unset rewrite.
Drop `usageLedgerMigratedAt` after a separate unset, or in the same rewrite.

### 5. Historical `runs.completionTransport`

Stored runs may still say `convex-action`. New inserts are `gateway`. The
field stays optional so those rows validate.

Remove the `convex-action` union member after a rewrite or a prod check shows
none remain.

### 6. Catalog snapshot fields on `runs`

Earlier gateway work stored `catalogVersion`, `contextWindowTokens`, and
`autoCompactTokenLimit` on new runs. Current inserts leave those unset. The
agent reads context budget from `GET /api/v1/models`; `getContext` returns
`0` when the snapshot is missing.

Keep the optional fields so rows that still have them validate. Unset them in
a later rewrite, then drop them from the schema.

### 7. Numbered transcript `migratedAt`

`threadTranscriptStates.migratedAt` is leftover after the numbered-transcript
backfill. Current writes do not set it.

Remove after an unset rewrite, then drop it from the schema.

## Client APIs

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
| `completion.complete` / `completion.summarize`                 | Convex-hosted model calls                                 |
| `messages.listHistoryForThread` / `messages.listLiveForThread` | UI transcript from Convex                                 |
| `modelCatalog.get`                                             | Static bundled catalog                                    |
| `uiPreferences.setLastThread` / `setPaymentsEmail`             | Session restore and mandate email writes                  |
| `webTools.scrapeUrl` / `webTools.webSearch`                    | Direct tool actions; current agents enqueue executor jobs |
| `payments` mandate setup with `userEmail`                      | Agents that sent the customer email themselves            |

Remove a stub when we are willing to let that function name disappear (old
installs then see a missing-function error instead of the update sentence).

### Live leftover name: `transcript.ensureMigrated`

Current desktop/server still call this (`transcript_client.rs` /
`transcript_watch.rs`). It only ensures `threadTranscriptStates` exists. It
does not read `threadMessages` and is not an unsupported-client stub.

Remove after rust/desktop stop calling it, then delete the Convex export.

## Removal checklist

1. Confirm the gate with prod numbers (schema) or an explicit decision that
   the function name can vanish (clients).
2. Land any data rewrite before shrinking validators.
3. Delete the shim, validator changes, and tests that only pin compat
   behavior, in one PR.
4. Remove the entry from this document.
