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

### OpenAI BYOK response item replay

Rig 0.42 can drop contentless reasoning items and regroup streamed output before
the next completion. OpenAI rejects the surviving message or function item IDs
when their required reasoning items are missing. `OpenAiReplayClient` clears
assistant message IDs and function item IDs on outgoing BYOK requests and sets
`store: false`. It requests and replays encrypted reasoning, and keeps function
call IDs used to pair tool results. Reasoning without encrypted content cannot
be replayed without server storage, so the adapter omits it. Stored transcripts
remain unchanged. Repairing older history is outside this fix's scope.

Remove this adapter only after the installed Rig version preserves complete
response item relationships through streaming and replay, and the BYOK
multi-turn regression passes with native item IDs.

## Local data directory backwards compatibility

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

### Current Migrations

`convex/migrations.ts` ships backfills for legacy stored fields that current code never writes.
The hourly cron runs `runLegacyCompatBackfillAutomatically`, which records completion in `migrationSchedules` under `legacy-compat-backfill-2026-10` once the migrations component reports every migration finished.
In serial order: `removeTranscriptStateWorkThrough`,
`removeMandateSetupUserEmail`, `normalizeScrapeUrlResults`,
`backfillExecutorJobToolInvocationId`, `migrateToolPartJobIds` (resolves each
part's job, so it runs after the job backfill),
`backfillCommandToolInputs` (resolves retained jobs after invocation IDs migrate),
`normalizeTranscriptCompletionTiming`, `stripStoredAttachmentImageUploadIds`,
`removeSectionLinkedParts`, and
`removeArtifactRegistryRekeyTargets`.

The runner checks the current migration list even when the schedule already
records completion, so adding a backfill reopens that schedule until the new
migration finishes.

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
preserve executor payloads only for `exec_cmd`, `exec_command`, `control_cmd`,
`control_command`, `poll_cmd`, `poll_command`, and `write_stdin`; other tool
events omit input to avoid duplicating large payloads. Remote sync retains the
field, and synthetic tool calls use it when no canonical completion call exists.
Canonical completion inputs remain authoritative. Missing legacy input produces
`null`, leaving the command session unknown rather than guessing from a call ID
or error message.

`backfillCommandToolInputs` fills only absent command inputs from retained
`executorJobs`, pairing by run and tool invocation ID, with legacy `jobId` as a
fallback. It verifies the job's run, thread, and tool kind and preserves existing
inputs. The legacy runner runs it after invocation-ID backfills. Remove that
migration and its `jobId` lookup after it completes and production scans confirm
all recoverable command inputs were backfilled; retire the shared `jobId` pairing
shim under the Tool invocation IDs gate above.

Until the migration finishes, command transcript retries hydrate an existing
part's absent input in the same transaction before strict retry comparison.
Other mismatches still fail and roll back the hydration. Remove this extra
lookup once production has no recoverable command parts with absent input and
all writers preserve command inputs.

Older local JSONL transcripts and derived history caches may have no command
input, and commands whose executor job was deleted cannot be backfilled. Those
historical inputs remain unknown; this change does not rebuild local caches or
invent missing payloads. Keep the optional field and missing-input fallback
while such history is supported. They cannot be removed solely because released
clients aged out or the Convex migration finished. Noncommand detail input stays
optional by design.
