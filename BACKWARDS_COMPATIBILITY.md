# Backwards Compatibility

Clients older than v0.4.2 are unsupported. Each shim below is temporary code with a removal gate. Remove an entry in the PR that removes its shim. Historical formats that stay forever are listed once at the end.

## Convex API shims

### Transcript part format

Released v0.5.x agents send completion `work`, separate `toolInvocations`, and section metadata on `beginToolJob`. Keep accepting those arguments. Current agents put `toolInvocationId` on each completion call item and send no section data. Completion `sections` are ignored, as described in "Retired transcript section summaries".

Released agents expect a boolean from `beginRun`, `saveContextHandoff`, `executor:complete` and `executor:fail`, and a completion document or `null` from `finalizeCompletionCall`. Callers get the created parts only with `returnParts: true`. Once agents that don't send it age out, return parts unconditionally and remove the old response shapes.

Released clients download parts through `transcript:getPartsPage`. Their replicas need `work` for grouping, `started` tool parts for running tools, and copied `callId`, `name` and command input on tool parts. Convex keeps writing all of these, deriving `work` and job sections for current agents in `lib/legacyTranscriptWork.ts`. Current readers ignore them: they derive blocks from item order, pair results by `toolInvocationId`, and skip `started` parts.

Once clients through v0.5.x age out, stop writing these fields, migrate `work` and old `completion.streamId` off stored parts, and drop copied tool fields where a matching call item has them. Keep every part number, including `started` parts.

### Retired subagent provider restriction

Released agents require `providerPreferences.restrictSubagentsToProvider` in `agentRuntime.getContext`, so it is always `false`. Released UIs still call `uiPreferences.setRestrictSubagentsToProvider`, which keeps saving the ignored `restrictSubagentsToProvider` field. Once those clients age out, remove the context field and the mutation, migrate the field off `uiPreferences` rows, then drop it from the schema.

### Retired conversation content sharing

Released UIs unmask session replays unless `uiPreferences.getMine` reports `shareConversationContent: false`, so it always does, returning only that field for users with no saved preferences. They also call `uiPreferences.setShareConversationContent`, which accepts and ignores the value. Released agents default the missing `shareConversationContent` in `agentRuntime.getContext` to `false` and send no content. Once those UIs age out, remove the mutation and the `getMine` override.

### Enabled providers for released clients

Released clients reject unknown completion providers. `uiPreferences.getMyEnabledProviders` and `agentRuntime.getContext` take the providers a client can parse as `knownProviders` and leave the others out of enabled providers and provider handoffs. Released clients omit it, so a missing `knownProviders` means `releasedClientProviders` in `lib/providerOrder.ts`: `spikonado`, `openai` and `chatgpt`. Once clients that omit it age out, make `knownProviders` required and remove `releasedClientProviders`.

### OpenAI-only credential actions

Released UIs call `providerCredentials:saveOpenAiKey` and `removeOpenAiKey`, and released agents call `issueOpenAiCredential`. They wrap `saveApiKey`, `removeApiKey` and `issueApiKey` with `provider: 'openai'`, except that `issueOpenAiCredential` throws string `data` instead of `PROVIDER_NOT_CONFIGURED`, because v0.4 agents read only string error data. Once the UIs and agents that call them age out, remove the three actions.

### Retired cloud request mutations

Released agents start cloud scrapes with `webRequests:start` or `firecrawlRequests:start` and hosted parses with `hostedParse:createUpload`. Current agents call the `/agent/scrape` and `/agent/parse` HTTP actions instead. The three mutations accept any arguments and throw "Update Sprocket to scrape pages and parse documents in the cloud.", so released agents never reach the rest of the old flows. Remove `hostedParse.ts`, `webRequests.ts`, `firecrawlRequests.ts` and `retiredCloudRequest` once clients that call them age out.

### Retired command sync

Released hosts call `commands:get` to decide whether to upload each local command session, and to read sessions they can't find on disk. `get` returns a finished, failed command with no output, so hosts mark every session synced, report missing sessions as failed, and never call the removed `sync` or `getLogChunks`. Remove `commands.ts` once hosts that call `commands:get` age out.

### Artifact types

Released agents send `contentType` to `artifacts:addArtifact` and `artifacts:editArtifact`, which accept and ignore it. Released agents read `type` from `artifacts:getArtifactForRun`, and released servers read it from `artifacts:listArtifacts`, so `artifacts.ts` derives it from the title. Released agents also start `add_artifact` and `edit_artifact` jobs, so `vCurrentExecutorJobKind` keeps both kinds. Once those clients age out, remove the argument and the derived `type` from the artifact functions, and move both kinds to `vStoredExecutorJobKind`. Stored jobs of both kinds stay readable, see the permanent list.

### Prompts recorded at run creation

Released agents omit `deferPrompt` from `agentRuntime.createGatewayRun` and `subagents:createOrSend`, so their runs record the prompt at creation and return it as `promptPart`. They also read `prompt` from `subagents:recoverSubmission`, send `beforePrompt: true` to `saveContextHandoff` and `omitReasoningReplay` (which places the handoff cutoff before the recorded prompt), and send `prompt` and `storageIds` to `finalizeFailedStart`, which ignores them. Once those agents age out, make `deferPrompt` the only path and remove `promptPart`, the `recoverSubmission` prompt, `beforePrompt`, and the ignored arguments.

### Run finalization text

Released agents send `text` to `agentRuntime.finalizeExecutorRun`, `finalizeFailedStart` and `finalizeClaimFailure`. All three accept and ignore it. Remove the argument once those agents age out.

### Usage-limit failure kind

Released v0.5.x agents send `failureKind: 'usage_limit'` to `agentRuntime.finalizeExecutorRun` when `issueGatewayCredential` throws the `USAGE_LIMIT_REACHED` code, and prefer that failure when every provider fails. The mutation accepts and ignores the argument. Once those agents age out, remove the argument.

### Retired transcript section summaries

Released agents send `sections` to `agentRuntime.finalizeCompletionCall`. The mutation accepts and ignores it. Remove the argument and `sectionOrder` once agents that send it age out. Transcript parts still keep `work`, and tool jobs still accept their section assignments, because supported clients use those fields to display history.

### Processed-token usage

Released agents send `processedTokens` to `agentRuntime.finalizeCompletionCall` (inside `usage`) and `agentRuntime.saveContextHandoff`. Both accept and ignore it, so those agents record no token usage. Remove the argument once those agents age out.

### Model call usage on transcript writes

Released agents send each call's usage as `usage.call` on `agentRuntime.finalizeCompletionCall` and as `handoffCalls` on `saveContextHandoff` and `beginRun`. Current agents send it to `agentRuntime.recordModelCall` when the call completes. Remove `usage.call`, `handoffCalls` and the code that records them once those agents age out.

### Question result booleans

Released agents complete `ask_question` and `poll_question` jobs with `pending`, `timedOut` and `skipped` booleans and `answer.optionLabel`, in place of `status`. `vPollQuestionResult` and `vAskQuestionResult` accept both shapes. Once those agents age out, migrate stored job results to `status`, drop `optionLabel` from them, and remove the boolean variants.

### Question job IDs

Released agents omit `jobId` from `agentQuestions:createWithOptionalExpiry`, so it falls back to the run's `activeJobId`. Make `jobId` required and drop the fallback once those agents age out.

### Retired Prava mandate tools

Released v0.4.x agents still start `mandate_setup`, `mandate_status`, `mandate_list`, `mandate_charge` and `mandate_report` jobs. `beginToolJob` accepts their payloads and fails them with "Payments moved to Agentcard. Update Sprocket to buy things." Remove the retired payload validators from the job-start path and `PAYMENTS_MOVED_TO_AGENTCARD` once those agents age out. Stored jobs stay readable, see the permanent list.

### Agent error text

Production Convex delivers only a `ConvexError`'s `data`. Agents from v0.4.3 and earlier match executor errors by that text, and `SPROCKET_SUBMISSION_WAITING` must match exactly. So `agentError` throws the legacy message from `lib/agentErrorCodes.json` as string `data`. Current agents map that text back to its code in `sprocket-convex/src/decode.rs` and also accept `{ code, message }` data. Once those agents age out, throw `{ code, message }` and remove the message lookup.

### Automatic recovery submission prefix

Hosts from v0.4.3 and earlier mark automatic recovery only with an `automatic-recovery:` submission-ID prefix, so `createQueuedRunRecord` treats that prefix like `automaticRecovery: true`. Remove `LEGACY_AUTOMATIC_RECOVERY_SUBMISSION_PREFIX` once those hosts age out.

### Fixed claim lease

Agents from v0.4.3 and earlier ignore `leaseDurationMs`. They assume a 120 s lease and renew it every 40 s. Keep `RUN_CLAIM_LEASE_DURATION_MS` at 120 s until they age out.

### Order reports without an outcome

Released agents call `payments:reportOrder` without `outcome`, which means `ordered`. Make `outcome` required once those agents age out. Stored `report_order` jobs without it stay readable, see the permanent list.

### Saved GitHub tokens

Released UIs call `githubCredentials:saveToken` and `removeToken`, and released hosts call `issueTokens` to read the tokens saved in WorkOS Vault. Current clients sign in through the GitHub CLI or read environment tokens and never call the module. Once those clients age out, delete `githubCredentials.ts` and the saved `sprocket-github-*` WorkOS Vault objects.

### Subagent listing and transcript pages

Released agents start `list_subagents` jobs and call `subagents:listChildren` for them, and read subagent transcripts through `subagents:transcriptPartsPage`. Current agents use `list_threads` with `threads:listForRun`, and `transcript:getPartsPageForRun` with `threadId`. Once those agents age out, delete both mutations and move `list_subagents` from `vCurrentExecutorJobKind` to the retired kinds in `vExecutorJobKind`. Stored `list_subagents` jobs stay readable, see the permanent list.

### Tool image URLs

Released agents send `parse_file` and `scrape_url` images to models as Convex storage URLs. They look each image up with `imageUploads:toolImageUrlsForRun` and upload missing ones through `registerToolImageForRun`, and v0.5.x agents fail the image when either call fails. Current agents send images inline as base64 and call neither. `migrations:deleteToolImages` deletes the tool-image rows, which are the ones with `sha256`, and their files, skipping threads with an active run because released agents reuse an image's URL until their run ends. The Convex Production workflow runs it after each deploy, and released agents upload an image again on their next turn. Once those agents age out, delete both mutations, the `by_threadId_and_sha256_and_storageDeletedAt` index, the `sha256` field and the migration, after deleting the tool-image rows added since. Remove the "Convex storage image URLs" shim in spikonado/ai-gateway's `BACKWARDS_COMPATIBILITY.md` at the same time.

## Convex data shims

### Completion provider defaults

Older `threadRecords` and `runs` rows lack `completionProvider`, so the schema keeps it optional. Convex readers, including provider handoffs and subagent settings, and the Rust agent's `RunSnapshot` treat a missing value as `spikonado`. `migrations:backfillThreadCompletionProviders` and `migrations:backfillRunCompletionProviders` set it, and the Convex Production workflow runs them after each deploy. Once `bunx convex run --component migrations lib:getStatus` reports both done on production, make the field required, drop the `?? 'spikonado'` reads and the Rust default, and remove the migrations.

### Stored usage-limit failure kinds

Older `runs` rows carry `failureKind: 'usage_limit'`, so the schema uses `vStoredRunFailureKind` and `projectSelectedThreadLifecycle` reports only `abandoned`. `migrations:clearUsageLimitFailureKinds` clears it, and the Convex Production workflow runs it after each deploy. Once `bunx convex run --component migrations lib:getStatus` reports it done on production, store `vRunFailureKind` and remove `vStoredRunFailureKind` and the migration.

### Stored conversation sharing preferences

Older `uiPreferences` rows carry `shareConversationContent`, so the schema keeps it optional. `migrations:dropShareConversationContent` unsets it, and the Convex Production workflow runs it after each deploy. Once `bunx convex run --component migrations lib:getStatus` reports it done on production and the "Retired conversation content sharing" shim is gone, drop the field and the migration.

### Migration records

`migrationSchedules` and the `migrations` component's data keep completion records for finished backfills. Remove the table and that data after an operator deletes or archives those records on each deployment.

### Migrated tool parts without invocation IDs

Tool parts written by the August 2026 transcript migration, with `migrated-tool:` source keys, lack `toolInvocationId`, so `vTranscriptToolBody` keeps it optional. `migrations:backfillToolInvocationIds` sets it to the source key, and the Convex Production workflow runs it after each deploy. Once `bunx convex run --component migrations lib:getStatus` reports it done on production, make the field required and remove the migration, its workflow step and the `migrations` component mount.

### Stored artifact types

Older `artifacts` rows carry `type`, so the schema keeps it optional. `migrations:removeArtifactTypes` deletes it, and the Convex Production workflow runs it after each deploy. Once `bunx convex run --component migrations lib:getStatus` reports it done on production, remove `type` from the schema and remove the migration.

### Completion call invocation IDs

Older completion parts keep tool invocation IDs only in `work.toolInvocations`. `migrations:backfillCompletionToolInvocationIds` copies each onto its call item, and the Convex Production workflow runs it after each deploy. Once `bunx convex run --prod --component migrations lib:getStatus` reports it done, remove the migration. `withToolInvocationIds` stays for released agents' writes, as described in "Transcript part format".

### Transcript context location

Older `threadRecords` rows carry `contextSummary`, `contextSummaryPartCount`, `contextSummaryHandoffKey` and `reasoningStrippedThroughPartNumber`. Writers now use `threadTranscriptStates`; readers fall back to the thread fields while `migrations:moveTranscriptContext` copies them and unsets the old fields. The Convex Production workflow runs it after each deploy. Once `bunx convex run --prod --component migrations lib:getStatus` reports it done, remove the four fields from `threadRecords`, the location fallback and the migration. `transcript:getState` and `getStateForRun` keep the same result shape for released clients.

### Subscription mirror legacy fields

Older `subscriptions` rows hold the retired webhook projection, including operator grants and free bootstrap rows without a Dodo subscription. So the schema keeps `tier`, `eventAt`, `accessPhase` and the other projection fields optional, along with the mirror's `dodoSubscriptionId`, `dodoProductId`, billing period, `cancelAtNextBillingDate` and `syncedAt`. `migrations:migrateSubscriptionRows` moves active grants to `users.grantedTier`, deletes the other rows without a Dodo subscription, cancels pending expiry checks and unsets the projection fields. `migrations:resyncDodoCustomers` then mirrors every Dodo customer's subscriptions. The Convex Production workflow runs both after each deploy. Once `bunx convex run --component migrations lib:getStatus` reports both done on production, drop the projection fields, make the mirror fields required, and remove both migrations.

### Retired billing tables

`subscriptionReconciliations`, `supersededSubscriptions`, `billingCheckoutSessions`, `billingCheckoutAttempts` and `dodoPricingCache` are untyped tables kept only so the schema accepts their old rows. `clearSubscriptionReconciliations`, `clearSupersededSubscriptions`, `clearCheckoutSessions`, `clearCheckoutAttempts` and `clearPricingCache` in `migrations.ts` delete their rows. Once all five report done on production, remove the tables and the migrations, and delete the unmounted `billingWebhookWorkpool` and `billingReconciliationWorkpool` components' data on each deployment.

### Dodo webhook ledger

`dodoWebhookEvents` keeps the retired webhook ledger so an operator can find customers it may have double-charged with `bunx convex run --prod billingAudit:listDoubleCharges`. Run it once `migrations:resyncDodoCustomers` reports done and the `dodo:syncCustomer` runs it spreads over the next hour have succeeded in the dashboard logs. Rerun any failed one by hand. After those refunds, run `bunx convex run --prod billingAudit:deleteWebhookEvents` on each deployment, then remove the table, `billingAudit.ts`, and the `billingAudit` assertions in `subscriptions.test.ts`.

### Question settle timestamps

Older `agentQuestions` rows carry an `answeredAt` that nothing reads, so the schema keeps it optional. `migrations:dropQuestionAnsweredAt` unsets it, and the Convex Production workflow runs it after each deploy. Once `bunx convex run --component migrations lib:getStatus` reports it done on production, drop the field and the migration.

### Rate limiter usage buckets

Usage charged before the `usage` table lives in `modelUsageMonthly` buckets of the `rateLimiter` component. Until a window has a `usage` row, `lib/quota.ts` reads its usage from `lib/legacyUsage.ts`, and the first charge copies it into the new row. The bucket key includes `subscriptions.quotaResetAt`, which `resolvePlan` returns as `legacyQuotaResetAt`. Every window open at this deploy ends within 32 days. In any deploy at least 32 days after this one reaches production, remove `lib/legacyUsage.ts` and its fallback, `quotaResetAt` with `legacyQuotaResetAt`, the `app.use(rateLimiter)` mount in `convex.config.ts` (which deletes the component's data), the `rateLimiterTest.register` call in `test.setup.ts`, the `@convex-dev/rate-limiter` dependency, its `vite.config.ts` entry, and the legacy usage test in `subscriptionUsage.test.ts`.

### Retired Prava mandate rows

`mandates` and `mandateCharges` are untyped tables kept only so the schema accepts their old rows. Remove both tables after `bunx convex run payments:deleteRetiredMandates` has emptied them on each deployment, and remove that mutation with them. Delete the unmounted `actionRetrier` component's data on each deployment at the same time.

### Retired command sync tables

`commandSessions` and `commandLogChunks` are untyped tables kept only so the schema accepts their old rows. `clearCommandSessions` and `clearCommandLogChunks` in `migrations.ts` delete those rows, and the Convex Production workflow runs both after each deploy. Once `bunx convex run --component migrations lib:getStatus` reports both done on each deployment, remove the tables and the migrations.

### Retired cloud request tables

`hostedParseRequests` and `webRequests` are untyped tables kept only so the schema accepts their old rows. `clearHostedParseRequests` and `clearWebRequests` in `migrations.ts` delete those rows, and the Convex Production workflow runs both after each deploy. The `storageCleanup.cleanupUnregistered` cron deletes the files they referenced. Once `bunx convex run --component migrations lib:getStatus` reports both done on each deployment, remove the tables and the migrations. Delete the unmounted `contextDevWorkpool` and `firecrawlScrapeWorkpool` components' data on each deployment at the same time.

### Stored executor job and result fields

Each of these Convex variants goes once a full production scan confirms no retained row uses it:

- `truncated` on `read_skill` results. Also wait for released clients that send it to age out.
- `hidden` on executor jobs. Sectionless jobs keep their terminal-write fallback during reconciliation until they're reconciled.
- `headSha` and non-`true` `conflicting` on `poll_pr` results.
- The `pending` executor job status, from before jobs were inserted as `claimed`.

## Local data directory shims

### Call item invocation IDs in local transcripts

Parts that released clients saved locally keep tool invocation IDs in `work.toolInvocations` instead of on their call items. `TranscriptPart` deserialization and `to_local_part` in `crates/sprocket-transcript` copy them onto the items with `normalize_legacy_tool_invocations`. Remove it once old local transcript caches are deleted and downloaded again, and `migrations:backfillCompletionToolInvocationIds` reports done on production.

### Windows private files from elevated runs

Older releases restricted private files to OWNER RIGHTS, so files an elevated run wrote are owned by Administrators and unreadable to the user's normal runs. On Windows, `ProfileLock::acquire` deletes those private files when the server can't read them. Remove it once releases before the per-user ACL are outside the direct-upgrade window.

### Completion item metadata

Transcripts from released clients lack `providerMetadata.rigNative` and `origin`. In `crates/sprocket-agent/src/history.rs`, `legacy_text_native_item` and `legacy_tool_call_fields` rebuild native items from their older `providerMetadata` fields, and a missing `reasoningIssuer` means `LEGACY_REASONING_ISSUER`. Released clients stored Anthropic thinking signatures as `openai.reasoningEncryptedContent`, so `legacy_anthropic_thinking` rebuilds the `thinking` block for an `anthropic.messages` origin. `assign_unidentified_legacy_history_origin` in `crates/sprocket-agent/src/types.rs` assigns the selected model's origin. Keep these fallbacks until a versioned migration rewrites all stored local JSONL and Convex transcripts.

## Launcher process shims

### Renamed npm package

Released clients only update `@spikonado/sprocket`, so the release workflow also publishes each version under that name. A launcher running as `@spikonado/sprocket` offers its next update as `usesprocket`, uninstalls the old package, and reinstalls it if the new install fails. Once a stable release with this switch is on every dist-tag of `@spikonado/sprocket`, stop publishing it, then remove `LEGACY_PACKAGE_NAME` and its update path.

### Restart exit code

An npm launcher from v0.4.3 and earlier stays in memory across in-app updates and restarts only when its child exits with code 75. Current launchers restart whenever the restart file exists and pass the native exit code up, so the native server still exits with `RESTART_EXIT_CODE` after an accepted restart. Remove `ServerExit` and that code once launchers from v0.4.3 and earlier are outside the supported upgrade window.

## Permanent history formats

Stored executor jobs, transcripts and local data files keep accepting these historical shapes so history stays readable. No lossless rewrite exists, so they have no removal gate:

- Tool parts with `status: 'started'`. Readers skip them, but retain their part numbers so transcript ranges stay contiguous.
- Historical tool results without a matching completion call, including `executor-job:<id>` call IDs. Their `name`, `callId`, and optional `input` preserve details unavailable in a call item.
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
- `report_order` payloads without `outcome`, which all reported orders.
- `eventsPath` on command tool results, which released servers still send.
- Command tool results without `nextOffset`, which released agents still send. The next read of that session starts from the beginning of its output.
- `apply_patch` results without `source` for renames and copies.
- `createdAt` on stored `list_artifacts` results.
- `summary` on `scrape_url` results, from before `outline` replaced it, `images`, from before image references moved into the markdown, and `highlights`, from before the tool dropped `query`.
- `query` on `scrape_url` payloads, which released agents still send. Scrapes ignore it.
- `numResults` on `web_search` payloads, which released agents still send. Search ignores it.
- Single-target `poll_cmd` (`sessionId`), `poll_subagent` (`threadId`, `cursor`) and `poll_pr` (`repository`, `number`, `cursor`) payloads and their single-object results, from before each poll took a list of targets. Released agents still send them.
- The retired `list_subagent_models` tool kind, including `defaultModelId`, `defaultFast`, and model `label`, `vendor` and `supportsImages` on its results.
- `lastError: null`, empty `pendingQuestions`, `settings.fast: false` and `settings.completionProvider` on subagent tool results, and `hasMore` on `list_subagents` results.
- The retired `list_subagents` tool kind, with its payloads and results.
- Completion items without `startedAt`, `completedAt` or `streamId`, and local parts without `createdAt`.
- `completionProvider: 'chatgpt'` on threads and runs. Local SIWC runs use the same ID, so `chatgpt` stays in `completionProviderIds`.
- Settled-tool output and section assignments of jobs without section metadata, which reconciliation preserves.
- Local readers of `scrape_url` and `read_skill` `truncated`, `jobId` pairing and command parts without input.
- `project-attachments.json` records without `lastMessageSentAt`, which load as 0 so those projects sort by `lastUsedAt`.
- Tool-output images cached before they were fitted for models, which `replay_image_output` fits on replay.
