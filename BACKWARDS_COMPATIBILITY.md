# Backwards Compatibility

Clients older than v0.4.0 are unsupported. Each shim below is temporary code with a removal gate. Remove an entry in the PR that removes its shim. Historical formats that stay forever are listed once at the end.

## Convex API shims

### Transcript downloads

Keep `transcript:getParts`, `transcript:getPartsForRun` and `subagents:transcriptParts` unchanged until clients that request explicit part numbers age out. New clients use page endpoints.

### Provider context handoffs

Run context responses optionally include `providerHandoff`. Released clients ignore it. Keep it optional, with the Rust missing-field default, until those clients age out. Missing historical provider IDs mean `spikonado`.

### Completion provider defaults

Released clients don't send `completionProvider`, and older thread and run rows lack it. Convex and the Rust agent treat a missing value as `spikonado`. Once those clients age out, migrate older rows to `spikonado`, then require the field.

### Retired cloud-held ChatGPT sign-in

`getMyConfiguration` reports `chatgpt: false` and `chatgptModelIds: null`. Remove those fields once no supported client reads them.

### Usage windows array

`usage.getMyUsage` keeps a `windows` array with a single `monthly` entry because released usage pages iterate it. Each meter's `description` is also only rendered by released clients. Drop both from `vMyUsage`, and `description` from `usageMeters`, once those clients age out.

### Subagent provider choice

Released runners omit `completionProvider` from `subagents:createOrSend`, so creation inherits the caller's provider and follow-ups keep the child's saved one. Make the argument required once those runners age out.

### Retired subagent provider restriction

Released agents require `providerPreferences.restrictSubagentsToProvider` in `agentRuntime.getContext`, so it is always `false`. Released UIs still call `uiPreferences.setRestrictSubagentsToProvider`, which keeps saving the ignored `restrictSubagentsToProvider` field. Once those clients age out, remove the context field and the mutation, migrate the field off `uiPreferences` rows, then drop it from the schema.

### Descendant status counts

`threads.subtreeSummaryForThread` still returns `descendantStatusCounts`, deriving `running` from `workingDescendantCount` and `completed` from the remaining total. Remove it once released inbox clients age out.

### Firecrawl request endpoints

Released agents call `firecrawlRequests:start`, `getResult` and `dispose`. These forward to `webRequests`, so released scrapes run on context.dev and return `outline` in place of `summary`. `start` rejects `kind: 'screenshot'` with "This tool is no longer supported." `getResult` and `dispose` accept any string ID, so IDs from the old table report the request as ended. Remove the module once clients that call `firecrawlRequests:*` age out.

### Artifact `createdAt`

Released servers require an integer `createdAt` on `artifacts:listArtifacts` rows, so the query fills it from the floored `_creationTime`. Remove that field once those servers age out.

### Artifact types

Released agents send `contentType` to `artifacts:addArtifact` and `artifacts:editArtifact`, which accept and ignore it. Released agents read `type` from `artifacts:getArtifactForRun`, and released servers read it from `artifacts:listArtifacts`, so `artifacts.ts` derives it from the title. Released agents also start `add_artifact` and `edit_artifact` jobs, so `vCurrentExecutorJobKind` keeps both kinds. Once those clients age out, remove the argument and the derived `type` from the artifact functions, and move both kinds to `vStoredExecutorJobKind`. Stored jobs of both kinds stay readable, see the permanent list.

### Machine credentials

Released clients call `machines:tryRegister` with a `credentialHash`, then `machines:heartbeat` and `machines:end` anonymously with the matching `credential`. The hash is stored as their `processId`. Remove those three mutations once those clients age out.

### Agent-reported claim lease loss

Released agents report claim lease loss through `agentRuntime.finalizeClaimFailure` with `lastError` set to `LEGACY_RUN_ABANDONED_BY_AGENT`. That mutation maps the text to `failureKind: 'abandoned'` and stores `RUN_ABANDONED_BY_MACHINE` instead. Remove the mapping once those agents age out.

### Prompts recorded at run creation

Released agents omit `deferPrompt` from `agentRuntime.createGatewayRun` and `subagents:createOrSend`, so their runs record the prompt at creation and return it as `promptPart`. They also read `prompt` from `subagents:recoverSubmission`, send `beforePrompt: true` to `saveContextHandoff` and `omitReasoningReplay` (which places the handoff cutoff before the recorded prompt), and send `prompt` and `storageIds` to `finalizeFailedStart`, which ignores them. Once those agents age out, make `deferPrompt` the only path and remove `promptPart`, the `recoverSubmission` prompt, `beforePrompt`, and the ignored arguments.

### Processed-token usage

Released agents send `processedTokens` to `agentRuntime.finalizeCompletionCall` (inside `usage`) and `agentRuntime.saveContextHandoff`. Both accept and ignore it, so those agents record no token usage. Remove the argument once those agents age out.

### Question result booleans

Released agents complete `ask_question` and `poll_question` jobs with `pending`, `timedOut` and `skipped` booleans and `answer.optionLabel`, in place of `status`. `vPollQuestionResult` and `vAskQuestionResult` accept both shapes. Once those agents age out, migrate stored job results to `status`, drop `optionLabel` from them, and remove the boolean variants.

### Retired Prava mandate tools

Released v0.4.x agents still start `mandate_setup`, `mandate_status`, `mandate_list`, `mandate_charge` and `mandate_report` jobs. `beginToolJob` accepts their payloads and fails them with "Payments moved to Agentcard. Update Sprocket to buy things." Remove the retired payload validators from the job-start path and `PAYMENTS_MOVED_TO_AGENTCARD` once those agents age out. Stored jobs stay readable, see the permanent list.

### Agent error text

Production Convex delivers only a `ConvexError`'s `data`. Agents from v0.4.3 and earlier match executor errors by that text, and `SPROCKET_SUBMISSION_WAITING` must match exactly. So `agentError` throws the legacy message from `lib/agentErrorCodes.json` as string `data`. Current agents map that text back to its code in `sprocket-convex/src/decode.rs` and also accept `{ code, message }` data. Once those agents age out, throw `{ code, message }` and remove the message lookup.

### Automatic recovery submission prefix

Hosts from v0.4.3 and earlier mark automatic recovery only with an `automatic-recovery:` submission-ID prefix, so `createQueuedRunRecord` treats that prefix like `automaticRecovery: true`. Remove `LEGACY_AUTOMATIC_RECOVERY_SUBMISSION_PREFIX` once those hosts age out.

### Fixed claim lease

Agents from v0.4.3 and earlier ignore `leaseDurationMs`. They assume a 120 s lease and renew it every 40 s. Keep `RUN_CLAIM_LEASE_DURATION_MS` at 120 s until they age out.

## Convex data shims

### Usage-generation key

Usage buckets key off `quotaResetAt` while released gateway readers still use it, so old and new servers charge the same bucket. New writes keep `quotaResetAt` as the transition timestamp, advanced by 1ms when transitions share a timestamp, and `quotaGeneration` counts transitions. After those readers age out, migrate outstanding usage into generation-keyed buckets before switching the key. Keep `quotaResetAt` until that migration completes.

### Legacy checkout attempts

Legacy ambiguous creates without a frozen request require provider reconciliation, and legacy subscription rows without `checkoutAttemptId` never prove activation of a specific attempt. Remove these fail-closed recovery paths after all pre-freeze ambiguous attempts resolve and legacy uncorrelated subscriptions terminate.

The checkout tables keep `by_userId` because released readers use it. Remove it once those readers age out and all current-session lookups use the compound indexes. Keep a creation-order history index while history iteration needs it.

### Calendar usage windows

The quota reader carries usage from old seven-day or thirty-day rate-limiter rows into the current calendar window only when the old window began inside it. Remove that read path once every deployment has run calendar windows for 30 days.

### Migration records

`migrationSchedules` and the `migrations` component's data keep completion records for finished backfills. Remove the table and that data after an operator deletes or archives those records on each deployment.

### Migrated tool parts without invocation IDs

Tool parts written by the August 2026 transcript migration, with `migrated-tool:` source keys, lack `toolInvocationId`, so `vTranscriptToolBody` keeps it optional. `migrations:backfillToolInvocationIds` sets it to the source key, and the Convex Production workflow runs it after each deploy. Once `bunx convex run --component migrations lib:getStatus` reports it done on production, make the field required and remove the migration, its workflow step and the `migrations` component mount.

### Stored artifact types

Older `artifacts` rows carry `type`, so the schema keeps it optional. `migrations:removeArtifactTypes` deletes it, and the Convex Production workflow runs it after each deploy. Once `bunx convex run --component migrations lib:getStatus` reports it done on production, remove `type` from the schema and remove the migration.

### Pricing cache keys

Older `dodoPricingCache` rows carry a `cacheKey` that nothing reads, so the schema keeps it optional. `migrations:dropPricingCacheKeys` unsets it, and the Convex Production workflow runs it after each deploy. Once `bunx convex run --component migrations lib:getStatus` reports it done on production, drop the field and the migration.

### Context summary part counts

Older threads store the context summary cutoff as `contextSummaryThroughPartNumber`, the inclusive last covered part with `-1` for an empty prefix. When `contextSummaryPartCount` is missing, `existingContextSummaryPartCount` uses that value plus one. `migrations:countContextSummaryParts` rewrites those rows, and the Convex Production workflow runs it after each deploy. Once it reports done on production, remove the old field, the fallback and the migration.

### Subscription rows without an access phase

Older subscription rows, including operator grants and free bootstrap rows, lack `accessPhase`, so the schema keeps it optional and readers treat a missing phase as `'none'`. `migrations:backfillSubscriptionAccess` materializes `accessPhase` and `accessEndsAt` on those rows and schedules their expiry checks, and the Convex Production workflow runs it after each deploy. Once `bunx convex run --component migrations lib:getStatus` reports it done on production, make `accessPhase` required, drop the `?? 'none'` reads in `lib/tiers.ts`, `subscriptionExpiry.ts` and `subscriptionReconciliation.ts`, and remove the migration.

### Retired Prava mandate rows

`mandates` and `mandateCharges` are untyped tables kept only so the schema accepts their old rows. Remove both tables after `bunx convex run payments:deleteRetiredMandates` has emptied them on each deployment, and remove that mutation with them. Delete the unmounted `actionRetrier` component's data on each deployment at the same time.

### Stored executor job and result fields

Each of these Convex variants goes once a full production scan confirms no retained row uses it:

- `truncated` on `read_skill` results. Also wait for released clients that send it to age out.
- `hidden` on executor jobs. Sectionless jobs keep their terminal-write fallback during reconciliation until they're reconciled.
- `headSha` and non-`true` `conflicting` on `poll_pr` results.

## Local data directory shims

### Native credential store selection

An absent `credentials/<account>/store.json` means automatic: keyring storage with file fallback. Released clients never wrote `"keyring"` when it was their default. Keep reading `"keyring"` and `"file"` while profiles from released clients are supported.

### Artifact binding scopes

Older `bindings.json` rows carry `scope` and `thread_id`. The first locked load drops them and keeps every ID, path and baseline. Remove legacy-field detection once supported data directories have been migrated.

### Windows private files from elevated runs

Older releases restricted private files to OWNER RIGHTS, so files an elevated run wrote are owned by Administrators and unreadable to the user's normal runs. On Windows, `ProfileLock::acquire` deletes those private files when the server can't read them. Remove it once releases before the per-user ACL are outside the direct-upgrade window.

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

## Launcher process shims

### Restart exit code

An npm launcher from v0.4.3 and earlier stays in memory across in-app updates and restarts only when its child exits with code 75. Current launchers restart whenever the restart file exists and pass the native exit code up, so the native server still exits with `RESTART_EXIT_CODE` after an accepted restart. Remove `ServerExit` and that code once launchers from v0.4.3 and earlier are outside the supported upgrade window.

## Permanent history formats

Stored executor jobs and transcripts keep accepting these historical shapes so history stays readable. No lossless rewrite exists, so they have no removal gate:

- `spawn_subagent` calls with `threadId`, from before follow-ups moved to `control_subagent`.
- Retired tool names `exec_command`, `control_command`, `poll_command`, `write_stdin` and `await_question`, their historical `yieldTimeMs` values, and question text, options and poll IDs in results.
- The optional `workdir` on `vExecCommandPayload`, shown as `(cwd …)` in the UI and ignored on replay.
- Retired tool kinds: the old artifact create and update tools, Browserbase `browser_observe`, `browser_act` and `browser_extract`, Firecrawl `browser_interact` and `browser_screenshot`, `screenshot_url`, and `list_connectors`.
- Scope and thread metadata on artifact tool payloads and results.
- `add_artifact` and `edit_artifact` jobs, from before `bind_artifact` replaced them, and the `repositoryKey`, `type`, `contentType`, `title`, `revision` and `updatedAt` fields on artifact tool results.
- `parse_file` URL sources and legacy command results.
- `name` and `description` on `read_skill` results.
- Retired Prava tool kinds `mandate_setup`, `mandate_status`, `mandate_list`, `mandate_charge` and `mandate_report`, with their payloads and results, including `mandate_status` results without `description`.
- `merchant` on `card_checkout` results, and `{ recorded: true }` `report_order` results.
- `eventsPath` on command tool results, which released servers still send.
- `apply_patch` results without `source` for renames and copies.
- `createdAt` on stored `list_artifacts` results.
- `summary` on `scrape_url` results, from before `outline` replaced it, and `images`, from before image references moved into the markdown.
- `numResults` on `web_search` payloads, which released agents still send. Search ignores it.
- The retired `list_subagent_models` tool kind, including `defaultModelId`, `defaultFast`, and model `label`, `vendor` and `supportsImages` on its results.
- `lastError: null`, empty `pendingQuestions`, `settings.fast: false` and `settings.completionProvider` on subagent tool results, and `hasMore` on `list_subagents` results.
- Completion items without `startedAt`, `completedAt` or `streamId`, and local parts without `createdAt`.
- `completionProvider: 'chatgpt'` on threads and runs. Local SIWC runs use the same ID, so `chatgpt` stays in `completionProviderIds`.
- Settled-tool output and section assignments of jobs without section metadata, which reconciliation preserves.
- Local readers of `scrape_url` and `read_skill` `truncated`, `jobId` pairing and command parts without input.
