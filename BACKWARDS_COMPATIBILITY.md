# Backwards Compatibility

We ship breaking changes ahead of our users' installed clients and keep the old behavior working until those clients age out. We also ship breaking changes to Convex schemas with migrations. That debt is easy to accumulate and easier to forget. This file lists every backwards-compatibility layer we currently ship, what it protects, how to remove it, and the signal that says removal is safe. When a removal PR merges, remove its entry from this document.

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
former scopes can resolve to the same file; synchronization pauses for all
colliding bindings until artifacts are saved or rebound to distinct paths.
Migration never writes artifact files. Remove legacy-field detection once all
supported clients have upgraded and their data directories have been migrated;
collision protection remains a general safety rule.

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

### Historical command wait values

Stored `exec_command` and `write_stdin` payloads keep accepting historical
`yieldTimeMs` values, including the former 10-second and 5-second defaults.
Current tools advertise zero or 30–270 seconds and clamp nonzero values at
execution. Zero returns metadata without returning or losing command output
for `exec_command` and `control_command`; `poll_command` returns output in both
modes, subject to its running-session zero-wait cooldown.
Keep the permissive historical payload validators permanently because transcript
history records the original calls. No stored-data rewrite is needed.

### Retired command control tool

New Rust agents advertise and execute `control_command` and `poll_command`
instead of `write_stdin`. Convex still accepts `write_stdin` jobs from released
agents, and the UI still renders their stored input, command results, session
labels, and log previews. New agents do not dispatch historical `write_stdin`
calls, so that name cannot bypass the new poll cooldown. Command sessions are
local to an agent run; no live-session or stored-data migration is needed.

Remove `write_stdin` from the current Convex job-kind validator after agents
that advertise it are outside the supported upgrade window. Keep acceptance
in stored-history validators and historical UI rendering permanently.

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
`normalizeTranscriptCompletionTiming`, `stripStoredAttachmentImageUploadIds`,
`removeSectionLinkedParts`, and
`removeArtifactRegistryRekeyTargets`.

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
