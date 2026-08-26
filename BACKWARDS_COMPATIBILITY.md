# Backwards compatibility removal plan

We ship breaking changes ahead of our users' installed clients and keep the old behavior working until those clients age out. That debt is easy to accumulate and easier to forget. This file lists every backwards-compatibility layer we currently ship, what it protects, how to remove it, and the signal that says removal is safe. When a removal PR merges, remove its entry from this document.

Current as of v0.3.2 (2026-08-22).

## How clients age out

Three client populations talk to the cloud backend:

- The served web app ships with the backend and updates on every deploy. It never needs compat.
- Installed desktop apps (AppImage/DMG/NSIS, shipped since v0.2.2) bundle their own web assets.
- The `@spikonado/sprocket` npm CLI and the Rust agent binaries it launches.

Compat shims only exist for the second and third groups. Every shim in sections 1–3 protects clients older than v0.3.2 (2026-08-22), the first release carrying the client halves of #187, #191, and #192; section 4 landed after v0.3.2 and protects clients up to and including v0.3.2. There is no client telemetry, so age-out signals are npm download counts per version plus the per-entry database checks below.

## 1. Executor liveness split out of `projects`

Source: #187, merged 2026-08-18. Heartbeat state moved from fields on `projects` to the `projectConnections` table, project ordering moved to creation order, and session restore stopped using `lastThreadId`. Clients up to v0.3.1 still use all three old behaviors, so four shims remain.

### 1a. `uiPreferences.setLastThread` and `lastThreadId`

`convex/uiPreferences.ts` keeps a deprecated `setLastThread` mutation because clients up to v0.3.1 call it on every thread switch and read `lastThreadId` for restore. The current client does neither; restore uses `pickThreadToRestore`.

Remove by deleting the mutation and dropping `lastThreadId` from `uiPreferencesFields` in `convex/lib/docs.ts`. The field is optional, so existing rows keep validating after removal; sweep leftover values afterwards if you want the rows clean.

Safe when no `uiPreferences` row has received a `lastThreadId` write for a trailing two-week window. Check directly against prod the way #174 did.

### 1b. `projects.listMine` `includeExecutorStatus` argument

Clients up to v0.3.1 omit the argument, so `listMine` still computes a live `executorStatus` per project and returns `vProjectListItem` instead of plain project documents. Current callers pass `false`, which skips that work entirely.

Remove by dropping the argument and the executor-status branch in `convex/projects.ts`, returning `v.array(vProjectDoc)` directly, deleting `vProjectListItem` from `convex/lib/docs.ts`, and removing `executorStatus`, `lastHeartbeatAt`, and `connectedClientId` from the `Project` type in `apps/web/src/lib/types/sprocket.ts`.

Safe when `listMine` traffic without the argument stops, which in practice means npm downloads for versions below v0.3.2 have flattened.

### 1c. Legacy liveness fields on `projects`

`lastHeartbeatAt` and `connectedClientId` stay optional in `projectFields` (`convex/lib/docs.ts`) so pre-split rows validate, and `legacyConnectionFromProject` in `convex/lib/projectConnection.ts` reads them until a project's first heartbeat creates its connection row. Their only consumer is the executor-status branch removed by 1b.

Remove immediately after 1b: run a one-off backfill unsetting both fields on existing projects, then delete them from `projectFields` along with `legacyConnectionFromProject`, and drop `getEffectiveExecutorStatus` too if nothing else consumes it by then.

Safe when the backfill reports zero projects carrying either field.

### 1d. `projects.lastSeenAt`

Still written on every project open by `upsertSelected` purely so old clients can order their sidebar by it. The current UI orders projects by creation. The field is required today, so stopping the writes needs a validator change first.

Remove in two steps: make the field optional while deleting both writes, then backfill the stale values unset and drop the field plus its entry in the `Project` type.

Same gate as 1a: no recent writes once the trailing window passes.

## 2. Retired model IDs on stored selections

Sources: #191 and #192, both merged 2026-08-21. The catalog dropped `gpt-5.6-terra`, `gpt-5.6-luna`, and `grok-4.5`, and renamed the DeepSeek IDs to `deepseek-v4-pro-0813` / `deepseek-v4-flash-0731`. The old IDs survive in `threadRecords.selectedModel` and `runs.selectedModel`.

Today's compat: `retiredModelIds` widens `vPersistedModelId` (`convex/lib/validators.ts`) so stored rows still validate, `coercePersistedModelId` maps each retired ID onto its replacement at read time with `defaultModelId` as the last resort, and `coercePersistedSelection` clamps service tiers the replacement no longer offers ('fast' is now Opus-only). Call sites: `agentRuntime.getContext`, stale-run recovery, and thread open in `+page.svelte`.

Remove by:

1. Running a batched internal mutation that rewrites `threadRecords.selectedModel` from retired IDs onto their replacements and clamps `serviceTier` where needed. Model it on the `migrateLegacyUsageBatch` cron from #170, whose scaffolding #174 deleted once prod showed zero unmigrated rows.
2. Rewriting `runs.selectedModel` in the same pass. Runs are historical records, but we are pre-GA, usage metering already changed under them, and keeping a second coercion path just for runs costs more than the fidelity is worth.
3. Shrinking both validators back to `vModelId`, then deleting `retiredModelIds`, `retiredModelReplacements`, `coercePersistedModelId`, and the model half of `coercePersistedSelection`, along with the tests pinning retirement behavior.

Safe when the migration sweep reports zero rows with retired IDs, verified against prod.

This one recurs. Every catalog refresh leaves retired IDs behind unless the refresh PR includes its own rewrite migration, so fold that migration into future refreshes and this section stays empty.

## 3. Opt-in `usagePolicy` on the catalog

Source: #200. `modelCatalog.get` gained an optional `includeUsagePolicy` argument so the composer can tell metered models from unlimited ones without changing the response for clients that never ask. Every client released before #200 omits the argument, and the query returns the exact v0.3.2 shape (`usagePolicy` absent from every model); current callers pass `true`, which attaches `usagePolicy: 'unlimited'` to unlimited models only.

Remove by dropping the argument and attaching `usagePolicy` unconditionally in `convex/modelCatalog.ts`, folding `CatalogModelWithUsagePolicy` back into `CatalogModel` (remove `usagePolicy` from the `Omit` in `convex/lib/models.ts`) and out of `convex/lib/uiModelCatalog.ts`, simplifying the `{ includeUsagePolicy: true }` call in `+page.svelte`, and collapsing `convex/modelCatalog.test.ts` to pin unconditional inclusion instead of the opt-in contract.

Safe when npm downloads for versions predating the release carrying #200 have flattened.

## 4. Mandate setup ignores the stored payments email

Up to v0.3.2, mandate setup resolved the customer email from the caller (`userEmail` tool argument or settings-screen input) with a fallback to `uiPreferences.paymentsEmail`, and the settings screen saved that email via `uiPreferences.setPaymentsEmail`. Setup now reads the WorkOS email that `ensureCurrentUser` syncs onto the caller's `users` row (executor actions have no usable caller identity — the run's auth token is a launch-time snapshot).

Today's compat: `mandateSetupArgs` (`convex/payments.ts`) still accepts an optional `userEmail` and ignores it, so pre-#204-era agents and settings screens keep passing theirs. `vMandateSetupPayload.userEmail` (`convex/lib/validators.ts`) stays accepted because stored `executorJobs.payload` rows written by those agents carry it. `uiPreferences.setPaymentsEmail` still writes the field for old settings screens, and `uiPreferences.paymentsEmail` stays optional in the schema so their rows keep validating.

Remove by dropping `userEmail` from `mandateSetupArgs` and `vMandateSetupPayload` (sweep stored `executorJobs.payload` rows first if any still carry it), deleting `uiPreferences.setPaymentsEmail`, unsetting `paymentsEmail` on existing `uiPreferences` rows, and dropping the field from the schema — all in one PR.

Safe when npm downloads for versions at or below v0.3.2 have flattened and a prod check shows no recent `paymentsEmail` writes (the way #174 verified).

## 5. Stored reasoning efforts dropped from the catalog

Source: the catalog change that removed `max` from Ox Alpha, GPT-5.6 Sol, Claude Opus 5, and Claude Fable 5. Stored `threadRecords.reasoningEffort` and `runs.reasoningEffort` rows can still say `max` for those models.

Today's compat: the hourly cron `migrations.rewriteDroppedMaxReasoning` (`convex/migrations.ts`, registered in `convex/crons.ts`) sweeps both tables and clamps any effort its model no longer supports onto that model's default, following the #170 template. It shipped in the same PR as the drop, is idempotent, and exits without writes once every row is valid.

No request-path compat ships. A client that submits a dropped effort gets a readable "… does not support max reasoning." error and recovers by picking a supported effort; the composer self-corrects against catalog efforts anyway.

Remove by verifying against prod that zero rows carry an unsupported effort, then deleting the cron entry from `convex/crons.ts` and `convex/migrations.ts` together.

Safe when npm downloads for versions predating the drop have flattened; verify the sweep rewrote everything with a prod check that zero unsupported rows remain.

## Completed removals, kept as precedent

Moving token counters off `threadRecords` (#170) shipped with lazy on-access migration, an hourly cron sweep, and response-shape merging for old clients. #174 later removed all of it in one PR after verifying prod directly: 46 threads, zero legacy fields remaining, 46 matching usage rows. That is the template. Verify counts against prod, then delete validators, mutations, cron entries, and their tests together.

A prod count is a snapshot, not a guarantee. Rows can surface later through backup restores or older deployments, and once fallbacks are gone, opening one silently reports zeroed usage instead of failing loudly. #174 accepted that trade-off knowingly. Re-check the same dashboard query for a few days after a removal like this, and state in the removal PR what late-arriving unmigrated rows will degrade to.

## Explicitly no compat shipped

So nobody goes hunting for shims that do not exist:

- Stream states are required for all runs. #108 rejected a legacy message-cursor fallback on purpose.
- #137 tightened schema optionality with an out-of-band dev-deployment backfill before prod existed.
- The light-mode default flip (#171) is additive. Explicit stored preferences are untouched.
- Accepting Begin Patch envelopes alongside unified diffs (#66) is a permanent feature, not compat.
- Dropping orphaned OpenAI item references (#188) must stay forever. Compaction can drop reasoning items from any history, not just pre-fix ones.
- Usage-limit run errors (#200) now throw ConvexErrors, so `runs.lastError` carries a readable sentence where production used to mask them to `[Request ID] Server Error` strings. Clients released before #200 render that sentence in their transcript banner. It is display-only text that clears on the next run, so no compat layer ships.
- Tool-call failures (#206) now throw ConvexErrors through the executor-facing functions and surface authored messages to the model via rig's `map_error`, so `executorJobs.error` and the model's tool result carry the real failure text where production used to mask it to `[Request ID] Server Error` strings (and rig used to redact it to "the tool failed"). Both audiences render plain display text, so no compat layer ships.
- Submitting a reasoning effort a model no longer supports throws a readable validation error instead of coercing to a default. The error is actionable and clears on the next send with any supported effort, so no compat layer ships.

## Removal checklist

1. Confirm the entry's gate with real numbers and paste them into the PR description.
2. Land any data migration or backfill before shrinking validators.
3. Remove the server shim, validator changes, and client-side types in one PR.
4. Delete tests that pin compat behavior. Keep coverage for behavior that survives.
5. Remove the entry from this document.
