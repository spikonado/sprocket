# Backwards Compatibility

We ship breaking changes ahead of our users' installed clients and keep the old behavior working until those clients age out. We also ship breaking changes to Convex schemas with migrations. That debt is easy to accumulate and easier to forget. This file lists every backwards-compatibility layer we currently ship, what it protects, how to remove it, and the signal that says removal is safe. When a removal PR merges, remove its entry from this document.

## Development tooling compatibility

### TypeScript compiler API

The web workspace aliases `typescript` to `@typescript/typescript6` for ESLint
and other tools that use the JavaScript compiler API. `@typescript/native`
aliases TypeScript 7 and provides the existing `tsc` command for type checks.
Remove the TypeScript 6 alias and restore the ordinary TypeScript dependency
once typescript-eslint and the other compiler API consumers support TypeScript
7's API. Released clients and stored data are unaffected.

## Provider SDK backwards compatibility

### Rig 0.43 upstream revision

Rig is pinned to upstream `e02ddcc6bd39e54e96bb5f48693896a6ebf26546`, the
first merged post-0.43 revision removing an unconditional partial-conversation
stderr dump from invalid-tool recovery. This revision retains 0.43's history
types but unifies streamed and awaited run errors as `PromptError`.
Return to a registry release only once it contains that fix and the provider,
replay, recovery, and handoff regressions pass. Never substitute unpinned main.

### SIWC streaming content type

The ChatGPT SIWC route can omit `Content-Type` on a successful streaming
Responses request. Rig requires `text/event-stream` before consuming it, so
the SIWC transport supplies that value only when the header is absent. Explicit
content types remain unchanged, and the stream must still reach a parsed
terminal Responses event. This does not change saved credentials or transcripts.

Remove the fallback once the SIWC route consistently sends the SSE content type
for supported accounts, or the installed Rig Responses client supports missing
content types, and the headerless-stream regression passes without it.

### Retired gateway model eligibility fields

Sprocket ignores `tierAllowedModels`, `modelLockUpgradeMessage`,
`tierAllowedServiceTiers`, and `serviceTierLockUpgradeMessage` in gateway
catalogs. The web client offers every gateway model and Fast mode on every
subscription tier. The gateway still returns these fields with every model and
service tier allowed for released clients that require them. Remove the gateway
response fields only after clients that validate or apply them are outside the
supported upgrade window. Model selections and Convex data need no migration.

### Stateless OpenAI reasoning replay

Rig 0.43 preserves and inlines Responses message and function items with their
native IDs, so the old `OpenAiReplayClient` ID-clearing workaround is removed.
Sprocket's `StatelessResponses` wire sets `store: false`, requests encrypted
reasoning, and omits reasoning without a nonempty encrypted payload. Summary-only
reasoning cannot be replayed without server storage. Function call IDs continue
to pair tool results; existing transcript formats remain unchanged.

Remove this wire wrapper once Rig exposes an equivalent stateless Responses
configuration and the BYOK and SIWC multi-turn replay regressions pass natively.

### Rig history identities

Released Sprocket history records carry separate `id` and optional `callId`
fields and omit tool names on results. The Rust history reader reconstructs
Rig 0.43's unified `CallId`, preserving a distinct item ID when present, and
resolves each result's required name from its preceding call. Historical
OpenAI-shaped reasoning blocks are sealed to the `openai` issuer when loaded.
No stored data is rewritten: local JSONL and Convex transcript formats remain
compatible with released clients.

New reasoning items retain summaries as display text, one opaque encrypted
replay payload in `providerMetadata.openai.reasoningEncryptedContent`, the item
ID in `providerMetadata.openai.itemId`, and the issuer in
`providerMetadata.reasoningIssuer`. Raw text, signatures and redacted blocks
are not persisted. Encrypted payload bytes are preserved verbatim without
duplication. The Rust reader reconstructs summary/encrypted blocks; missing
issuers default to `openai` for released histories. The history fields remain
`id` and `blocksJson`; issuer-aware histories encode sealed projected reasoning
inside `blocksJson`, while the reader still accepts released block arrays.
This additive metadata format needs no backfill. Keep the existing replay
fields, array reader and missing-issuer default until supported clients age out
or a versioned migration rewrites all supported histories. Stateless BYOK/SIWC
replay still requires a nonempty encrypted payload.

New tool-call items retain the provider item ID in `providerMetadata.openai.itemId`,
the opaque signature in `providerMetadata.signature`, and native additional
parameters in `providerMetadata.toolCallAdditionalParams`. `callId` stays the
provider's tool-result correlator. Explicit `null` additional parameters mean
the native call had none. Released readers ignore the added metadata;
new readers fall back to `callId` and the historical metadata shape for old
items. This additive format widening needs no backfill; IDs already discarded
by older releases cannot be recovered.

Text items preserve Rig's `openai_responses` extras, including their message ID
and phase. Single-message completions add the call's message ID there when Rig
only reports it on the terminal response; multi-message item IDs take precedence.

Keep this boundary conversion while Sprocket's transcript protocol uses these
fields. Remove it only with a versioned protocol migration that rewrites all
supported histories and supports direct upgrades from released clients.

## Local data directory backwards compatibility

### Thread-relative model images

Stored model messages can reference `parse_file/…`, `screenshot_url/…`, or
`scrape_url/…` images relative to their transcript directory. Chat rendering
passes the message's user/thread scope to `/workspace/image` for those paths.
The workspace takes precedence; missing workspace files fall back to the
thread cache so existing images in tool-named project folders keep working.
Other workspace/document-relative and absolute paths retain their behavior.
The optional scope also applies to revision checks. Existing clients may omit
it, and no transcript or Convex data is rewritten.

Remove this path-resolution shim only after a migration replaces every stored
tool-cache image reference with a durable image reference and supported agents
no longer emit thread-relative tool-cache paths.

### Legacy artifact binding scopes

Existing local `bindings.json` rows accept `scope` and `thread_id`; the first
locked load atomically drops those fields while retaining every
registration/artifact ID, path, and content baseline. Bindings from different
former scopes can resolve to the same file; synchronization pauses and explicit
deletion rejects colliding bindings until artifacts are saved or rebound to
distinct paths. Rejected deletion leaves the shared file and bindings intact
and does not request cloud deletion. Migration never writes artifact files.
Remove legacy-field detection once all supported clients have upgraded and
their data directories have been migrated; collision protection remains a
general safety rule, not a removable compatibility shim.

### Local project message recency

Older `project-attachments.json` files omit `lastMessageSentAt`. The server
defaults it to zero and rewrites missing fields on load. Historical send times
cannot be recovered from attachment records, so projects without a recorded
send use `lastUsedAt` as their ordering fallback. The UI also accepts the absent
field. Remove these defaults and the missing-field rewrite after releases
without this field are outside the supported direct-upgrade window and all
supported stores have been rewritten.

### Forgotten SIWC accounts

Older servers kept tokenless ChatGPT account records after sign-out. Loading
`chatgpt-siwc.json` now removes tokenless records with no outstanding revocations,
clears tokenless active selections, and removes empty user entries before saving
the store. Records with retained refresh tokens stay until a status check
attempts their revocation through the normal sign-out path, then deletes them.
Interrupted-refresh recovery moves the refresh token into that retained list.
An unconfirmed revocation produces a status warning with ChatGPT settings
guidance. Records left by terminal refresh failures follow the same rule.
Sign-out saves a hidden tokenless revocation record until its bounded attempt
finishes, so a restart can retry an interrupted attempt. This record keeps only
the existing client/connection IDs, a new session ID and refresh tokens. The
subject becomes the non-identifying `signed-out` placeholder so older readers
still accept the record. The label and other tokens are cleared before the
attempt.
The host ID stays unchanged. Remove this cleanup
only after releases that retained signed-out records are outside the
supported direct-upgrade window and supported stores have been rewritten.

### Replaced SIWC sessions

Local SIWC accounts accept an absent `retiredRefreshTokens` list in older files.
Reconnects record replaced refresh tokens there before trying revocation, then
remove confirmed revocations. Sign-out attempts every retained revocation before
deleting the local account record. Remove the default only after a migration
writes this field into every supported older store and direct upgrades from
unmigrated stores no longer need support. An unreadable credential file
disables only ChatGPT, leaves the file untouched, and reports repair guidance
in settings.

### CLI bootstrap error guidance

Older servers return HTTP 401 for CLI version and Convex deployment mismatches.
The CLI adds restart and configuration guidance to bootstrap 401 responses.
Remove that fallback and its legacy-response test once servers without the
separate HTTP 409 compatibility errors are outside the supported upgrade window.

### Retired repository rekey metadata

Older servers may have written `previousRepositoryKey` into
`project-attachments.json`. The current attachment record does not deserialize
or use that field. On the first successful attachment load, the server inspects
the raw JSON for it and forces a save, which rewrites the file without the
field. The rewrite also persists any changes made while validating the stored
attachments.

After releases that wrote `previousRepositoryKey` are outside the supported
direct-upgrade window, remove the raw JSON field-presence check and its legacy
JSON test fixture. Keep the save triggered by attachment validation changes.

## Convex Backwards Compatibility

### Subagent follow-up tool routing

`spawn_subagent` creates children and rejects `threadId` at runtime. Follow-ups
use `control_subagent` with `action: "send"`. Stored executor payload validation
and UI rendering retain historical `spawn_subagent(threadId)` calls without
rewriting their tool names or identities. That historical shape remains
permanently for readable transcripts, not for execution; no data migration is
needed. The shared Convex submission endpoint handles creation and follow-ups
without interpreting or translating legacy tool schemas.

### Legacy agent question expiry

Released agents call `agentQuestions:create`, which keeps its original
contract: an omitted `timeoutMs` defaults to 30 minutes and numeric values are
clamped to [1s, 24h]. Current agents call `agentQuestions:createWithOptionalExpiry`,
where omitted or `null` `timeoutMs` means no expiry and any finite non-negative
integer is honored without a floor or cap; zero commits an already timed-out
question atomically. Both endpoints share one implementation.

Positive deadlines retain the existing scheduled-mutation semantics: an overdue
pending question remains answerable until its timeout mutation commits. Zero
lifetimes are terminal at creation, without a scheduler race.

`agentQuestions.timeoutAt` and its snapshot field are now optional; questions
without an expiry omit the field. The widening is the entire migration:
existing rows, deadlines, and answers are untouched and no backfill rewrites
deadlines. Stored `ask_question` job payloads now also accept `timeoutMs: null`
alongside historical numbers; that permissive payload validator stays
permanently because transcript history records the original calls.

Remove `agentQuestions:create` and its clamping resolver after agents that call
it are outside the supported upgrade window. `timeoutAt` stays optional as long
as no-expiry questions exist.

### Historical command wait values

Stored `exec_command` and `write_stdin` payloads keep accepting historical
`yieldTimeMs` values, including the former 10-second and 5-second defaults.
Exec and control accept zero or any positive wait up to 270 seconds; poll
advertises zero or 10–270 seconds and clamps nonzero values at execution.
Zero returns metadata without returning or losing command output
for `exec_cmd` and `control_cmd`; `poll_cmd` returns output in both
modes, subject to its running-session zero-wait cooldown.
Keep the permissive historical payload validators permanently because transcript
history records the original calls. No stored-data rewrite is needed.

### Retired command control tool

New Rust agents advertise and execute `control_cmd` and `poll_cmd`
instead of `write_stdin`. Convex still accepts `write_stdin` jobs from released
agents, and the UI still renders their stored input, command results, session
labels, and log previews. New agents do not dispatch historical `write_stdin`
calls, so that name cannot bypass the new poll cooldown. Command sessions are
server resources scoped to the user and thread. New commands save thread-local
session records beside their logs; no stored transcript rewrite is needed.

Remove `write_stdin` from the current Convex job-kind validator after agents
that advertise it are outside the supported upgrade window. Keep acceptance
in stored-history validators and historical UI rendering permanently.

### Durable command sessions

New `exec_cmd` results always include a string `sessionId`, even when the command
finishes during its initial wait. Completed polls return a bounded preview of the
full output rather than only its previously unread tail. Existing result shapes,
saved transcript results, and log paths remain valid. Thread-local session records
and the `commandSessions` and `commandLogChunks` Convex tables are additive;
released servers stored no such records, so no migration is needed.

Released servers did not persist a mapping from session IDs to logs. Session IDs
already lost on restart or pruning cannot be reconstructed reliably; no numeric-ID guess or
log retargeting is attempted. Session IDs for newly launched commands remain
UUIDs, preventing old IDs from controlling replacement processes. No compatibility
shim or migration is introduced for data that was never stored.

### Renamed command and question tools

Current agents advertise `exec_cmd`, `control_cmd`, `poll_cmd`, and
`poll_question`, replacing `exec_command`, `control_command`, `poll_command`,
and `await_question`. Convex accepts the former names for released agents and
the UI renders both names. Current agents do not dispatch the former names.
No stored-history rewrite is needed.

All five command/question tools default to 10-second execution waits. Positive
poll waits clamp to 10–270 seconds, and pending zero-wait polls have a 10-second
cooldown. Current question results omit question text/options; only
`ask_question` returns `questionId`. Result validators also retain historical
question text/options and poll IDs for released agents and transcript history.

Remove former names from the current job-kind validator once agents advertising
them age out of the supported upgrade window. Keep stored-history acceptance
and UI rendering permanently.

### Terminal transcript readiness

Existing `runExecutionStates` omit `terminalJobsReconciled`. Before accepting a
follow-up, the backend reconciles that legacy run using bounded transactions;
`agentRuntime.prepareSubmission` reports not-ready while results are still
pending, and run creation rejects with the `SPROCKET_SUBMISSION_WAITING`
sentinel instead of staging the message; native code waits for readiness and
retries creation. A waiting prompt lives only in the local process and
disappears if it dies, so no server-side queue exists to recover.
`migrations:runTerminalJobBackfill` proactively reconciles existing terminal
runs and runs automatically from an hourly cron. It can also be triggered after
deploying this schema; active runs gain the field when they
finish. Remove the missing-field fallback only after the backfill has completed,
pre-deployment active runs have finished, and released backends without this
field are outside the rollback window.

### Project-owned artifacts

Released agents may send `scope: 'thread'` to `artifacts.addArtifact` or include
artifact scope/thread metadata in executor payloads and results. The add mutation
accepts that optional argument but always stores and returns project scope.
Released web/server clients may send `threadId` to artifact reads and sync;
Convex validates the supplied thread's ownership and repository but authorizes
artifact access by user and repository only. All current read responses normalize
legacy rows to `scope: 'project'` and omit `threadId`. Remove these API arguments
after clients sending them have aged out.

The hourly `runProjectArtifactBackfillAutomatically` runner records completion
under `project-artifacts-2026-10`, separately from earlier compatibility backfills.
`promoteThreadArtifacts` rewrites stored thread artifacts to project scope and
removes `threadId`, preserving IDs, registration IDs, content revisions and
timestamps while advancing each project's registry revision. Add retries and
successful edits/syncs also normalize legacy rows in place. Remove the stored
thread-scope/threadId schema fields, reader projection, migration and its cron
only after the migration finishes and production scans find no legacy rows.
Historical executor tool payloads/results retain optional scope/thread metadata
permanently because conversation history describes the original calls.

### Billing (Dodo) backwards compatibility

#### Legacy subscription rows without access/projection fields

Subscription rows written before the durable-billing projection may omit
`projectionRevision`, `payloadEventAt`, `termEventAt`, `accessPhase`, and
`accessEndsAt`. Readers treat missing access fields as `paid`/`none` per the
legacy `billingPeriodEnded` flag, and missing watermarks as the row's
`eventAt`. `backfillSubscriptionAccess` fills the materialized access
phase/deadline and projection revision, and `backfillSubscriptionExpiry`
reschedules boundary checks fenced by the new revision. Both are idempotent.

Removal gate: after `runSubscriptionAccessBackfill` and
`runSubscriptionExpiryBackfill` have run to completion in production, the
legacy fallbacks in `lib/tiers.ts` and `subscriptionExpiry.ts` can be removed
and the fields made required.

#### Legacy usage-generation key (`quotaResetAt`)

Usage buckets key off the subscription's usage generation. Rows written
before the monotonic `quotaGeneration` counter carry `quotaResetAt`, an event
timestamp used as the same key. While released gateway readers still use that
timestamp, current readers prefer `quotaResetAt` too; otherwise old and new
servers would charge different buckets. New writes retain `quotaResetAt` as the
transition timestamp, advancing it by 1ms when distinct winning tier transitions
share a timestamp, while `quotaGeneration` counts the durable transitions;
`backfillSubscriptionAccess` derives the initial generation from the
legacy timestamp so the migration neither resets usage nor mints allowance.

Removal gate: after released readers that key directly on `quotaResetAt` age
out, migrate outstanding usage into generation-keyed buckets before changing
the key preference. A subscription backfill alone does not migrate consumed
allowance. Keep the timestamp field until that migration completes.

#### Usage display time

New clients pass `now` to `usage.getMyUsage` and refresh it each minute. The
optional argument preserves released clients calling with `{}`; that legacy
display-only path retains its wall-clock fallback until those clients age out.
Entitlement and charge mutations never trust the browser's display time.

Removal gate: after all supported clients pass `now`, require the argument and
remove the query clock fallback.

#### Checkout attempt retention

`billingCheckoutSessions` keeps the current selection; superseded attempts
live in `billingCheckoutAttempts` so already-created payment links stay
payable and their provider idempotency keys survive. Legacy attempts used the
attempt id as the provider idempotency key but did not always persist it.
Recovery requires a persisted key, frozen body, and first-create timestamp
inside an operator-confirmed provider idempotency window; it never invents a
key for an ambiguous attempt. Missing proof fails closed for support repair.
The 24h reservation TTL is not provider expiry. All retained selections count
toward the 25-row account limit, including locally expired payable links.
Terminal rows lose hosted URLs/create bodies immediately and are removed after
30 days; never-sent reservations are removed 30 days after local expiry.
Unresolved/payable records remain until authoritative resolution. Subscription
and superseded-identity records retain purchase identity after checkout cleanup.

Legacy ambiguous creates without a frozen request cannot safely reconstruct
the old return origin/customer. They require provider reconciliation instead
of a speculative create with changed parameters. Legacy subscription rows
without `checkoutAttemptId` never prove activation of a specific attempt.

Removal gate: after all pre-freeze ambiguous attempts resolve and legacy
uncorrelated subscriptions terminate, remove these fail-closed recovery paths.

#### Checkout creation-order indexes

The checkout tables retain `by_userId` alongside the attempt/session indexes
because released readers use it and bounded history iteration needs creation
order. Remove the current-session shim only after released readers age out and
all current lookups use the compound indexes. Keep the history index while
creation-order iteration remains necessary.

#### Webhook dedup retention

`dodoWebhookEvents` keeps identity/outcome rows for the 14-day provider replay
horizon; settled payloads are pruned after 48h while outcome/duplicate
counts persist for dedup. Pending, failed, unresolved, competing, and unsupported
payloads remain replayable until the 14-day horizon, when the full row expires.
Cleanup chains bounded batches over a fixed ingestion snapshot on each run.
The legacy `dodoWebhookCleanup` cursor remains diagnostic; scheduled continuation
arguments carry progress. Remove that table after released cleanup callers age out
and its diagnostic rows have been migrated or deleted. Payload secrets and customer
details are never logged.

### Retired cloud-held ChatGPT sign-in

Cloud-held ChatGPT/Codex OAuth is retired in favor of local sign in with
ChatGPT (SIWC). Released clients still call
`providerCredentials.beginChatGptBrowserLogin`,
`completeChatGptBrowserLogin`, `cancelChatGptBrowserLogin`,
`beginChatGptDeviceLogin`, `pollChatGptDeviceLogin`,
`cancelChatGptDeviceLogin`, `refreshChatGptModels`,
`removeChatGptCredential`, and `issueChatGptCredential`. Each keeps its
original argument validator and always rejects with guidance to connect
locally with SIWC; no cloud sign-in, exchange, refresh, or credential
issuance remains. `getMyConfiguration` keeps its shape but always reports
`chatgpt: false` and `chatgptModelIds: null`, and `chatGptConnection`
returns `null` for historical chatgpt runs after validating the run secret.
Stored `completionProvider: 'chatgpt'` rows on threads and runs keep their
validator and stay readable; `completionProviderIds` retains `chatgpt`.

The hourly `retireChatGptCloudCredentials` action deletes every
`sprocket-chatgpt-` credential object from WorkOS Vault with bounded
best-effort refresh-token revocation, deletes each
`providerCredentialStates` row only after its Vault object deletion is
confirmed (Vault failures abort the run, which the next cron retries), and
then enumerates Vault for prefix-named objects without metadata rows. The
`providerCredentialStates` table stays in the schema until the cleanup has
emptied it and released clients have aged out; then drop the table, the
retired ChatGPT stubs, `chatGptConnection`, and the retirement cron and
helpers. Keep `chatgpt` in `completionProviderIds` and the run and thread
validators. Local SIWC runs use the same provider ID as historical Codex runs.

### Calendar usage windows

Dodo subscriptions may omit `billingPeriodEnded` and `billingPeriodCheckId`. The clock check still enforces their access deadline. `backfillSubscriptionExpiry` schedules a database update at each existing Dodo deadline, or marks an elapsed period immediately, so subscribed queries refresh without changing provider status. An hourly cron starts or resumes the migration. Operator grants remain unchanged. Remove the backfill and its cron after it has completed on every deployment. The fields stay optional while operator grants exist.

Old rate-limiter rows use seven-day or thirty-day windows with randomized starts. The current quota reader carries usage from an old row into the current UTC calendar window only if the old window began inside that calendar window. The old rows do not record charge timestamps, so usage from a window that began before the new calendar boundary cannot be safely attributed to the current window. On first charge, the current window records eligible old usage along with the new charge. New paid terms never inherit an old window. Existing operator-managed subscriptions may omit billing dates and continue to use calendar months; Dodo subscriptions created by the new webhook persist their billing dates.

Remove the old rate-limiter read path once every deployment has been running calendar windows for at least 30 days. Old component rows are removed by the 62-day retention job. Leave the optional subscription fields in place until any older subscription rows have billing dates or have ended.

### Retired repository rekey calls

Released local servers may still call `threads.rekeyRepository`, and deployments
may have queued `artifacts.continueRekey` jobs. Both functions are no-ops. They
must not move threads or artifacts when a checkout's remote changes. Remove
both functions and their no-op compatibility tests after clients containing
automatic repository rekeying have aged out and no queued continuation jobs
remain.

### Completion provider defaults

Released clients do not send `completionProvider`, and existing thread and run
rows do not contain it. Convex and the Rust agent treat a missing value as
`spikonado`. Keep the field optional until released clients have aged out and a
migration has written `spikonado` to every older row. Then require the field and
remove the defaults.

### Standalone thread usage writes

Released agents call `agentRuntime.recordContextUsage` after every provider
completion. Current agents send usage with `finalizeCompletionCall` and
`saveContextHandoff` so Convex stores usage only with durable transcript data
or a successful handoff. Keep the standalone mutation until released agents
using it have aged out, then remove the mutation and its direct tests.

### Descendant thread status counts

`threads.subtreeSummaryForThread` adds `descendantStatusCounts` while retaining
`descendantCount`, `anyActive`, and `descendantsActive` unchanged for released
clients. Older `threadHierarchyStates` rows may omit `ownStatus` and
`descendantStatusCounts`; missing counts read as five zeros, and missing
`ownStatus` means the thread has not contributed a status to its ancestors yet.
Uncounted descendants are unknown, not working; the UI labels the difference
between `descendantCount` and the sum of known statuses as "Status updating".

`runThreadHierarchyStatusBackfill` visits each `threadRecords` row through
`refreshThreadHierarchyActivity`, atomically recording its current status and
applying deltas to every ancestor. It is idempotent alongside live status
changes and does not rebuild descendant counts or scan subtrees. The hourly
`runThreadHierarchyStatusBackfillAutomatically` cron records completion under
`thread-hierarchy-status-counts-2026-10` in `migrationSchedules`.

Remove the backfill, its cron, and its schedule row only after the runner reports
completion and production checks confirm every thread has contributed its
status and every ancestor's counts cover its descendants. At that point,
stored counts may become required and the missing-count fallback may be removed.
Keep `ownStatus` optional for newly ensured states until they are refreshed;
do not initialize it before propagating the contribution. Keep the original
summary fields until clients using them are outside the supported upgrade window.

The stored `threadHierarchyStates.descendantCount` is temporary duplicate
bookkeeping once status counts cover every descendant. Remove its writes only
after the status backfill finishes and production checks confirm that each
stored total equals the sum of its `descendantStatusCounts`. Then derive the
API's `descendantCount` from that sum and remove the UI's "Status updating"
fallback. Keep the API field for released clients until they are outside the
supported upgrade window; removing storage does not require removing the API
field. Ship a migration in the removal PR to strip the stored totals, retaining
an optional schema field until the migration finishes and production checks
confirm no rows contain it. Only then remove the schema field and migration.
`ownActive`, `ownStatus`, and `activeDescendantCount` are not covered by this
removal gate: they still support incremental updates and pending-question activity.

### Current Migrations

`convex/migrations.ts` ships backfills for legacy stored fields that current code never writes.
The hourly cron runs `runLegacyCompatBackfillAutomatically`, which records completion in `migrationSchedules` under `legacy-compat-backfill-2026-10-command-inputs` once the migrations component reports every migration finished.
In serial order: `removeTranscriptStateWorkThrough`,
`removeMandateSetupUserEmail`, `normalizeScrapeUrlResults`,
`backfillExecutorJobToolInvocationId`, `migrateToolPartJobIds` (resolves each
part's job, so it runs after the job backfill),
`backfillCommandToolInputs` (resolves retained jobs after invocation IDs migrate),
`normalizeTranscriptCompletionTiming`, `stripStoredAttachmentImageUploadIds`,
`removeSectionLinkedParts`, and
`removeArtifactRegistryRekeyTargets`.

The command-input backfill uses a new schedule name so completed
`legacy-compat-backfill-2026-10` schedules do not block it. Already-finished
migrations remain finished in the migrations component. The old schedule rows
may be deleted after the command-input backfill completes.

After the runner reports completion and production scans confirm no row carries
the old fields, a later PR may: drop `workThrough`, `linkedParts`, mandate
`userEmail`, scrape `truncated` from the schema and validators; require
`summary`/`images` on scrape results; require `toolInvocationId` on executor
jobs and transcript tool parts and drop `jobId` and its pairing fallback;
normalize or require stored completion timing; drop stored `imageUploadId`.
That PR may also drop `artifactRegistries.rekeyTo`. The optional field remains
in the schema until the migration has completed and production scans find no
rows that use it. At that point, also remove `removeArtifactRegistryRekeyTargets`,
its test, and its entry in the migration sequence. After every migration in
the sequence meets its removal gate, remove the backfill cron, runner, tests,
and the `migrationSchedules` row and table.

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

#### Historical Firecrawl browser tools

The Firecrawl browser provider is gone. `browser_interact` and
`browser_screenshot` moved out of `vCurrentExecutorJobKind`, so `beginToolJob`
rejects new jobs for them while stored jobs keep their validators so
conversation history remains readable. The `browserSessions` and
`browserProfiles` tables are dropped; the next browser implementation is local
and keeps its own state. Any remote Firecrawl session still live at deploy time
expires on its own within the provider's hard TTL. The browser live-view UI
components stay in place, stubbed against local state, for the local browser.

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

#### Patch source paths

Historical `apply_patch` results omit `source` for rename and copy operations.
Stored result validators and filtered subagent monitors accept that absence and
report only the known destination. Source paths cannot be recovered reliably
from unexecuted patch inputs, so this historical result variant stays permanently.

#### Retired tool visibility flag

All current agent tools receive work sections and appear in the transcript.
New executor jobs omit `hidden`. The stored validator still accepts that field
on historical rows; no migration rewrites old jobs or repairs old transcripts.
Remove the stored field once those rows age out.

`beginToolJob` accepts the old `hidden` argument only to allow sectionless calls
from released agents. It does not store the flag or suppress transcript events.
Sectionless jobs persist started and terminal parts without work membership;
agents need an update to display those calls in work sections. Remove this
argument and the sectionless write fallback once those agents age out.

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

#### Command result snapshots

Local `replica/history.sqlite3` caches previously indexed command sessions and
kept yielded calls pending until a later poll observed process completion. On
open, caches with the old `source_refs.session` column rebuild their read index
and work summaries transactionally from retained transcript parts. Coverage,
replica identity, and raw transcript results are preserved; changed rows receive
a new generation so connected clients refresh them. Convex data and tool
payload/result formats are unchanged.

Section boundaries are unchanged by snapshot semantics, so migration reuses the
stored `closed` flags instead of rescanning each run for every section.

Remove this local migration once supported installations no longer have caches
with the session column, or a later cache migration also rebuilds these indexes.

#### Command tool inputs

Tool detail bodies accept optional `input`. Current started and terminal events
preserve display inputs only for `exec_cmd`, `exec_command`, `control_cmd`,
`control_command`, `poll_cmd`, `poll_command`, and `write_stdin`; other tool
events omit input to avoid duplicating large payloads. Only `cmd`, `workdir`,
`sessionId`, and `action` are copied; command and workdir strings are capped at
8192 characters with an ellipsis, and session IDs over 128 characters are omitted
rather than truncated. Stdin contents and execution options are never copied.
This keeps started/terminal events and backfills small. Remote sync retains the
field, and synthetic tool calls use it when no canonical completion call exists.
Canonical completion inputs remain authoritative. Synthetic calls prefer their
start input, then terminal input for mixed-version caches only when invocation
IDs (or legacy job IDs), run, and tool kind match. Missing legacy input produces
`null`, leaving the command session unknown rather than guessing from a call ID
or error message.

`backfillCommandToolInputs` fills only absent command inputs from retained
`executorJobs`, pairing by run and tool invocation ID. It verifies the job's
thread and tool kind and preserves existing inputs. The legacy runner runs it
after invocation-ID backfills, which also translate legacy `jobId` references.
Remove this migration after it completes and production scans confirm all
recoverable command inputs were backfilled; retire the shared `jobId` pairing
shim under the Tool invocation IDs gate above.

Until the migration finishes, command transcript retries hydrate an existing
part's absent input using the existing append lookup. The candidate part must
pass strict retry comparison before a patch is written; other mismatches still
fail. Normal appends and already-hydrated retries perform no additional database
queries or writes. Remove this hydration once production has no recoverable
command parts with absent input and all writers preserve command inputs.

Older local JSONL transcripts and derived history caches may have no command
input, and commands whose executor job was deleted cannot be backfilled. Those
historical inputs remain unknown; this change does not rebuild local caches or
invent missing payloads. Keep the optional field and missing-input fallback
while such history is supported. They cannot be removed solely because released
clients aged out or the Convex migration finished. Noncommand detail input stays
optional by design.
