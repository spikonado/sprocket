# Backwards compatibility

This file lists shims we still ship. When a removal PR merges, delete its
entry. Age-out is a prod check for stored rows, or an explicit decision that
a retired function name can disappear.

Current as of 2026-08-30.

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

### 8. Response-half of `threadMessages`

Runs used to keep a response `threadMessages` row: started by the executor,
scrubbed on superseded attempts, backfilled with the merged transcript parts
when the run terminalized. The per-completion and terminal-cleanup code paths
already record every completed model call and settled tool into the numbered
transcript (`threadTranscriptParts`), the agent replays history from
transcripts and jobs, and the UI builds its thread from transcripts alone.
The backfill could also exceed the 1 MiB document limit with enough tool
output, failing `agentRuntime:finalizeRun`.

New runs no longer create the row: `finalizeRunRecord` writes nothing to
`threadMessages`, `beginAssistantMessage` is a no-op kept for the agent
contract, and `runs.responseMessageId` stays unset. Abstracted terminal text
is deliberately not preserved anywhere; an incomplete completion call stays
incomplete in the transcript.

`clearResponseMessageParts` (the live `migrations` entry, driven by the
migrations cron) rewrites every remaining response row to `{ text: "", parts:
[] }` and doubles as the read/write gate for the future schema change. Once
its status in prod is `success` with zero remaining rows, `runs` gets an
unset rewrite for `responseMessageId` and then, only after all released
agents/desktops have dropped `agentRuntime.beginAssistantMessage` calls:

1. Delete `agentRuntime.beginAssistantMessage` (or convert it to the
   unsupported-client stub like the other retired function names).
2. Drop `runs.responseMessageId` and `threadMessages.parts`, and the
   `by_type_runId` index, from `convex/schema.ts` and regenerate.
3. Delete `migrations.clearResponseMessageParts` and its `run` pin.

The prompt-half of `threadMessages` (text, attachments, retention bookkeeping)
stays: it is the run-capability source of the user prompt and image
attachments for `agentRuntime.getContext` and dedups repeated submissions.

### 9. Pre-migration `userId` rows (subject vs. tokenIdentifier)

Owned tables used to store `identity.subject` in their `userId` column. New
writes store `identity.tokenIdentifier` (`getUserId`). `users` rows carry
both keys (`subject` + `tokenIdentifier`), and the per-table owner-rewrite
migrations in `migrations.ts` rewrite stored `userId`s into the canonical
tokenIdentifier.

Dual-read shims kept until the rewrites are confirmed in prod:

- `users.by_subject` index plus by-subject/by-tokenIdentifier fallbacks in
  `ensureCurrentUser` / `resolveStoredOwnerSubject`
- `getOwnerKeys` plus the ownership gates in `lib/access.ts` accept a stored
  `userId` of either form
- `lib/access.ts` `resolveStoredOwnerKeys` validates a stored key against
  both forms
- `threads.listMine` / `threads.create` and run submission lookups union
  both keys so the sidebar and idempotency survive until rewrite
- subscription tier and usage-meter reads union the legacy subject's rows
  (`lib/tiers.ts`, `lib/rateLimits.ts`); charges keep writing the key that
  already has the open window, preferring an active monthly window so a
  weekly reset cannot split the month across keys. Quota checks and the
  usage view add both keys' current used so an already-split month still
  blocks. Rate-limiter component keys are not rewritten by the owner
  migrations and last until those windows roll.
- Prava customer ids stay on each mandate row's original key;
  `payments.getUserEmail` accepts either key form

Remove after the owner-rewrite migrations have run in production and a prod
check shows no owned rows (besides `users.subject`) still carrying a
subject-shaped `userId`.

### 10. Browser-forwarded WorkOS tokens for local Rust clients

Current web clients issue a rotating session credential through authenticated
Convex, deliver it to the paired local server once, and let Rust renew it every
five minutes. Identity-sensitive Rust calls send that credential; run-scoped
calls retain their existing execution secret. A chain remains valid for ten
minutes after its last successful renewal. Each browser/local-server pairing
has its own session ID, so one user's local servers rotate independently.

Released clients may still authenticate Rust's Convex connection with a
browser-forwarded WorkOS JWT. Keep `/auth/convex-token`, the Rust token
provider, and the identity fallback on `agentRuntime.createGatewayRun` and the
identity-based transcript functions until all supported clients seed rotating
credentials and production telemetry shows no legacy calls. Sign-out does not
actively revoke a credential yet; its remaining authority is bounded by the
ten-minute renewal window.

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
