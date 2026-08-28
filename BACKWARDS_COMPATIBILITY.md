# Backwards compatibility

This file lists shims we still ship. When a removal PR merges, delete its
entry. Age-out is a prod check for stored rows, or an explicit decision that
a retired function name can disappear.

Current as of 2026-08-27.

## Stored schema

Optional fields, dual-writes, and `@convex-dev/migrations` jobs that keep
documents written under an older schema valid. Current clients do not depend
on these shims. Fold a rewrite into the PR that introduces the next breaking
schema change instead of leaving a coerce path behind.

The component runner is `internal.migrations.runSeries` (every 10 minutes).

### 1. Legacy fields on `uiPreferences`

Source: #187, plus later catalog/payments work.

Optional fields kept so existing rows validate. Nothing current writes them:

- `uiPreferences.lastThreadId` — restore uses `pickThreadToRestore`
- `uiPreferences.paymentsEmail` — mandate setup uses the WorkOS identity email

The `projects` and `projectConnections` tables stay in the schema so existing
rows and leftover `projectId` fields validate. Threads now store
`repositoryKey` (optional until `backfillThreadRepositoryKeys` copies it from
`projects`). `projectId` on `threadRecords` / `runs` / `executorJobs` is
optional and unset by `unsetRunProjectIds` / `unsetExecutorJobProjectIds`.
Local `project-attachments.json` rows that still have `projectId` are
rewritten on load to `workspacePath` + `repositoryKey`. Older clients that
still call `projects.listMine` / `upsertSelected` / `heartbeatAttached` get
the unsupported-client update error.

Remove the leftover tables and `projectId` fields after those migrations
report zero remaining rows, then drop `repositoryKey` optionality.

Remove the remaining `uiPreferences` fields by unsetting each in a one-off
backfill, then dropping them from `convex/schema.ts`.

Safe when a prod check shows zero rows carrying the field.

### 2. Retired model IDs on stored selections

Sources: #191, #192, and later catalog drops. Retired ids:
`gpt-5.6-terra`, `gpt-5.6-luna`, `grok-4.5`, `stealth/ox-alpha`,
`deepseek-v4-pro`, `deepseek-v4-flash`. They survive on
`threadRecords.selectedModel` and `runs.selectedModel`.

`coercePersistedModelId` / `coercePersistedSelection` map known ids at read
time (`agentRuntime.getContext`, stale-run recovery, thread open).
`rewriteRetiredThreadModels` and `rewriteRetiredRunModels` are the durable
cleanup.

Remove the coerce helpers, `retiredModelIds`, and `retiredModelReplacements`
once the rewrite passes report zero remaining rows. Keep `selectedModel` as
`v.string()`.

Every later catalog drop should ship its own rewrite in the same PR.

### 3. Mandate job payloads still accept `userEmail`

Up to v0.3.2, mandate setup stored the caller email on
`executorJobs.payload`. `vMandateSetupPayload.userEmail` stays optional so
those rows validate. Live callers that still send `userEmail` are rejected as
an unsupported client (see below).

Remove by dropping the field after a prod sweep shows no stored mandate-setup
jobs carrying it.

### 4. Numbered transcript parts backfill

Durable history is `threadTranscriptParts` plus
`threadTranscriptStates.totalParts`. `transcript.ensureMigrated` plus
`migrateLegacyRunTranscriptParts` and `verifyThreadTranscriptReplicas` backfill
threads that only have `threadMessages` rows.

Remove `ensureMigrated` and the message-table read in those migrations once
every `threadRecords` row has `threadTranscriptStates.migratedAt` and the
component reports both passes done.

### 5. Aggregate usage ledger dual-write

Processed-token totals moved to `threadUsageEvents` plus a namespaced
Aggregate. `recordThreadUsageEvent` still dual-writes
`threadUsage.totalTokensProcessed`. `getThreadUsageValues` reads that field
until `usageLedgerMigratedAt` is set, then prefers the Aggregate sum.
`backfillThreadUsageLedger` inserts one baseline event per existing field
total.

Remove the field, the dual-write, and the pre-migration read once the
component reports that pass done and every `threadUsage` row has
`usageLedgerMigratedAt`.

### 6. Runs missing a lifecycle workflow

`startMissingRunLifecycles` starts the watcher on active runs that have no
`lifecycleWorkflowId` (rows from before run lifecycle lived on Convex).

Remove the migration once a prod check shows no non-terminal run without a
workflow id.

### 7. Historical `runs.completionTransport`

Stored runs may still say `convex-action`. New inserts are `gateway`. The
field stays optional so those rows validate.

Remove the `convex-action` union member after a rewrite or a prod check shows
none remain.

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

## Removal checklist

1. Confirm the gate with prod numbers (schema) or an explicit decision that
   the function name can vanish (clients).
2. Land any data rewrite before shrinking validators.
3. Delete the shim, validator changes, and tests that only pin compat
   behavior, in one PR.
4. Remove the entry from this document.
