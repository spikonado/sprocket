# Backwards Compatibility

Clients older than v0.4.0 are unsupported. Each shim below is temporary code with a removal gate. Remove an entry in the PR that removes its shim. Historical formats that stay forever are listed once at the end.

## Convex API shims

### Transcript downloads

Keep `transcript:getParts`, `transcript:getPartsForRun` and `subagents:transcriptParts` unchanged until clients that request explicit part numbers age out. New clients use page endpoints.

### Provider context handoffs

Run context responses optionally include `providerHandoff`. Released clients ignore it. Keep it optional, with the Rust missing-field default, until those clients age out. Missing historical provider IDs mean `spikonado`.

### Completion provider defaults

Released clients don't send `completionProvider`, and older thread and run rows lack it. Convex and the Rust agent treat a missing value as `spikonado`. Once those clients age out, migrate older rows to `spikonado`, then require the field.

### Gateway model eligibility fields

Gateway catalogs still return `tierAllowedModels`, `modelLockUpgradeMessage`, `tierAllowedServiceTiers` and `serviceTierLockUpgradeMessage`, with everything allowed. Sprocket ignores them. Remove them once clients that validate or apply them age out.

### Retired cloud-held ChatGPT sign-in

`getMyConfiguration` reports `chatgpt: false` and `chatgptModelIds: null`. Remove those fields once no supported client reads them.

### Usage windows array

`usage.getMyUsage` keeps a `windows` array with a single `monthly` entry because released usage pages iterate it. Each meter's `description` is also only rendered by released clients. Drop both from `vMyUsage`, and `description` from `usageMeters`, once those clients age out.

### Subagent provider choice

Released runners omit `completionProvider` from `subagents:createOrSend`, so creation inherits the caller's provider and follow-ups keep the child's saved one. Make the argument required once those runners age out.

### Descendant status counts

`threads.subtreeSummaryForThread` still returns `descendantStatusCounts`, deriving `running` from `workingDescendantCount` and `completed` from the remaining total. Remove it once released inbox clients age out.

### Screenshot tool

Released agents can still start `screenshot_url` jobs. Their `firecrawlRequests:start` call with `kind: 'screenshot'` fails with "This tool is no longer supported." Move the kind to the historical kinds once those agents age out.

### Repository rekey continuation

`artifacts.continueRekey` is a no-op for already-queued jobs. Remove it after a scheduler scan finds no queued continuation jobs.

### Artifact `createdAt`

Released servers require an integer `createdAt` on `artifacts:listArtifacts` rows, so the query fills it from the floored `_creationTime`. Remove that field once those servers age out.

### Tree cancellation batch arguments

`runLifecycle.cancelDescendants` accepts and ignores `rootThreadId` and `generation` from batches queued before the stateless sweep. Remove them after a scheduler scan finds no queued batch carrying them.

### Machine credentials

Released clients call `machines:tryRegister` with a `credentialHash`, then `machines:heartbeat` and `machines:end` anonymously with the matching `credential`. The hash is stored as their `processId`. Remove those three mutations once those clients age out.

## Convex data shims

### Billing subscription projection

Subscription rows written before the durable-billing projection may omit `projectionRevision`, `payloadEventAt`, `termEventAt`, `accessPhase` and `accessEndsAt`. Readers derive access from the legacy `billingPeriodEnded` flag and watermarks from `eventAt`. `backfillSubscriptionAccess` and `backfillSubscriptionExpiry` fill them idempotently. Once production scans confirm every subscription has the fields and rescheduled expiry checks, remove the fallbacks in `lib/tiers.ts` and `subscriptionExpiry.ts` and make the fields required.

### Usage-generation key

Usage buckets key off `quotaResetAt` while released gateway readers still use it, so old and new servers charge the same bucket. New writes keep `quotaResetAt` as the transition timestamp, advanced by 1ms when transitions share a timestamp, and `quotaGeneration` counts transitions. After those readers age out, migrate outstanding usage into generation-keyed buckets before switching the key. Keep `quotaResetAt` until that migration completes.

### Legacy checkout attempts

Legacy ambiguous creates without a frozen request require provider reconciliation, and legacy subscription rows without `checkoutAttemptId` never prove activation of a specific attempt. Remove these fail-closed recovery paths after all pre-freeze ambiguous attempts resolve and legacy uncorrelated subscriptions terminate.

The checkout tables keep `by_userId` because released readers use it. Remove it once those readers age out and all current-session lookups use the compound indexes. Keep a creation-order history index while history iteration needs it.

### Webhook cleanup cursor

The legacy `dodoWebhookCleanup` table stays for diagnostics. Remove it after released cleanup callers age out and its rows are migrated or deleted.

### Machine process IDs

Machine rows written before `processId` keep it in `credentialHash`, and `machineProcessId` reads either. Registration moves it, and `migrations:runMachineProcessIdBackfill` moves the rest. Once that migration completes on every deployment, make `processId` required and drop `credentialHash`.

### Calendar usage windows

`backfillSubscriptionExpiry` and its hourly cron schedule updates at existing Dodo deadlines. Remove them after the backfill completes on every deployment.

The quota reader carries usage from old seven-day or thirty-day rate-limiter rows into the current calendar window only when the old window began inside it. Remove that read path once every deployment has run calendar windows for 30 days. `billingPeriodEnded` and `billingPeriodCheckId` stay optional while operator grants or older subscription rows without billing dates exist.

### Migration records

`migrationSchedules` keeps completion records for finished backfills. Remove the table after an operator deletes or archives those records on each deployment.

### Legacy `createdAt` fields

`users`, `machines`, `threadUsageEvents`, `agentQuestions`, `artifacts`, `mandates` and `mandateCharges` rows written before `_creationTime` replaced `createdAt` still carry it, so the schema keeps it as `legacyCreatedAt`. The hourly `migrations.removeCreatedAt` cron clears it. Once that migration completes on every deployment, remove `legacyCreatedAt`, the migrations and the cron.

### Legacy thread record fields

Older `threadRecords` rows still carry `submissionId` and `treeCancellation`, so the schema keeps both optional. The hourly `migrations.runThreadRecordLegacyFieldsRemoval` cron clears them. Once that migration completes on every deployment, remove both fields, the migration and the cron.

### Stored executor job and result fields

Each of these Convex variants goes once a full production scan confirms no retained row uses it:

- `payload.userEmail` on mandate setup jobs written through v0.3.2.
- `truncated` on `scrape_url` results, and results without `summary` or `images`.
- `truncated` on `read_skill` results. Also wait for released clients that send it to age out.
- `hidden` on executor jobs. Sectionless jobs keep their terminal-write fallback during reconciliation until they're reconciled.
- `imageUploadId` on prompt attachments.

### Tool invocation IDs

Older tool parts use `jobId` and `tool:<jobId>` source keys. Readers pair by `jobId` when `toolInvocationId` is absent, and `executorJobs.toolInvocationId` stays optional. Remove the Convex fallbacks after a full scan confirms every job and tool part has an invocation ID and no tool part carries `jobId`.

### Command tool inputs

Command transcript retries hydrate an existing part's absent input through the existing append lookup, after strict retry comparison. Remove this hydration once production has no recoverable command parts with absent input and all writers preserve command inputs.

## Local data directory shims

### Native credential store selection

An absent `credentials/<account>/store.json` means automatic: keyring storage with file fallback. Released clients never wrote `"keyring"` when it was their default. Keep reading `"keyring"` and `"file"` while profiles from released clients are supported.

### Thread-relative model images

Stored model messages can reference `parse_file/…`, `screenshot_url/…` or `scrape_url/…` images relative to their transcript directory. `/workspace/image` checks the workspace first, then falls back to the thread cache, using the optional user/thread scope. Remove this after a migration replaces every stored tool-cache image reference and supported agents stop emitting those paths.

### Artifact binding scopes

Older `bindings.json` rows carry `scope` and `thread_id`. The first locked load drops them and keeps every ID, path and baseline. Remove legacy-field detection once supported data directories have been migrated.

### Project message recency

Older `project-attachments.json` files omit `lastMessageSentAt`. The server defaults it to zero, rewrites the file, and orders those projects by `lastUsedAt`. Remove the default and rewrite once releases without the field are outside the direct-upgrade window.

### Repository rekey metadata

Older servers may have written `previousRepositoryKey` into `project-attachments.json`. The first attachment load detects it in the raw JSON and saves the file without it. Remove the raw field check and its fixture once those releases are outside the direct-upgrade window.

### Signed-out SIWC accounts

Older servers kept tokenless ChatGPT account records after sign-out. Loading `chatgpt-siwc.json` removes tokenless records with no outstanding revocations, clears tokenless active selections and drops empty user entries. Revocation records use the `signed-out` subject placeholder so older readers accept them. Remove the cleanup once releases that kept signed-out records are outside the direct-upgrade window and supported stores are rewritten.

### Replaced SIWC sessions

Older SIWC account files may omit `retiredRefreshTokens`. Remove the default once a migration writes the field into every supported store.

### Running server from before an update

A server process started before an update returns HTTP 401 instead of 409 for CLI version and Convex deployment mismatches. The CLI adds restart guidance to bootstrap 401 responses. Remove that fallback and its test once servers without the 409 errors are outside the supported upgrade window.

### Completion item metadata

Transcripts from released clients lack `providerMetadata.rigNative` and `origin`. `transcript/history.rs` rebuilds native items from their older `providerMetadata` fields, and `assign_unidentified_legacy_history_origin` assigns the selected model's origin. A missing `reasoningIssuer` means `openai`. Keep these fallbacks until a versioned migration rewrites all stored local JSONL and Convex transcripts.

### Command history cache

On open, `replica/history.sqlite3` caches with the old `source_refs.session` column rebuild their read index and work summaries from retained transcript parts. Remove this migration once supported installations no longer have such caches.

## Permanent history formats

Stored executor jobs and transcripts keep accepting these historical shapes so history stays readable. No lossless rewrite exists, so they have no removal gate:

- `spawn_subagent` calls with `threadId`, from before follow-ups moved to `control_subagent`.
- Retired tool names `exec_command`, `control_command`, `poll_command`, `write_stdin` and `await_question`, their historical `yieldTimeMs` values, and question text, options and poll IDs in results.
- The optional `workdir` on `vExecCommandPayload`, shown as `(cwd …)` in the UI and ignored on replay.
- Retired tool kinds: the old artifact create and update tools, Browserbase `browser_observe`, `browser_act` and `browser_extract`, Firecrawl `browser_interact` and `browser_screenshot`, and `screenshot_url`.
- Scope and thread metadata on artifact tool payloads and results.
- `parse_file` URL sources, legacy command results and `mandate_status` results without `description`.
- `apply_patch` results without `source` for renames and copies.
- `createdAt` on stored `list_artifacts` results.
- Completion items without `startedAt`, `completedAt` or `streamId`, and local parts without `createdAt`.
- `completionProvider: 'chatgpt'` on threads and runs. Local SIWC runs use the same ID, so `chatgpt` stays in `completionProviderIds`.
- Settled-tool output and section assignments of jobs without section metadata, which reconciliation preserves.
- Local readers of `scrape_url` and `read_skill` `truncated`, `jobId` pairing and command parts without input.
