# Backwards Compatibility

Clients older than v0.4.0 are unsupported. We keep compatibility for supported clients and their stored data, including direct upgrades from older local data directories. This file lists each remaining compatibility layer and its removal gate. Remove an entry when its removal PR merges.

## Transcript download compatibility

Keep `transcript:getParts`, `transcript:getPartsForRun` and
`subagents:transcriptParts` unchanged for released clients. Remove them once
clients that request explicit part numbers age out. New clients use page
endpoints. Stored transcript formats are unchanged.

## Web request endpoint compatibility

### Firecrawl request endpoints

Released agents call `firecrawlRequests:start`, `getResult` and `dispose`.
Those endpoints now forward to `webRequests`, so released scrapes run on
context.dev and return `outline` in place of `summary`. `start` rejects
`kind: 'screenshot'` with "This tool is no longer supported.". `getResult`
and `dispose` accept any string ID, so IDs from the old table report the
request as ended. Remove the module once clients that call
`firecrawlRequests:*` age out.

### `firecrawlRequests` table

The table and the module's `cleanup` and `removeResult` functions stay so
cleanups scheduled before the rename still run. Rows live at most 8 minutes,
so drop the table and those functions in a follow-up once the table is empty.

## Development tooling compatibility

### TypeScript compiler API

The web workspace aliases `typescript` to `@typescript/typescript6` for ESLint
and other tools that use the JavaScript compiler API. `@typescript/native`
aliases TypeScript 7 and provides the existing `tsc` command for type checks.
Remove the TypeScript 6 alias and restore the ordinary TypeScript dependency
once typescript-eslint and the other compiler API consumers support TypeScript
7's API. Released clients and stored data are unaffected.

## Provider SDK backwards compatibility

### Provider and model-vendor context handoffs

Run context responses optionally include `providerHandoff` with the previous
provider's model settings. Released clients ignore this field. Keep it optional
and keep the Rust missing-field default until those clients age out.

The source comes from uncovered transcript completions and uses the existing
summary cutoff. Missing historical provider IDs still mean `spikonado`. Local
transcripts, saved provider settings and Convex documents keep their existing
formats, so existing threads need no migration.

If that handoff fails, the selected provider continues from the same visible
history with reasoning replay omitted. The thread may store optional
`reasoningStrippedThroughPartNumber`, an inclusive part cutoff. Released
clients ignore the field. Transcript state responses include it when set, and
older local transcript state files load without it. Parts, summaries and
provider settings stay in their existing formats, so no migration is required.
The cutoff is persistent replay state, not a compatibility shim. Keep it until
a migration removes the covered reasoning from stored transcript parts.

### Released completion item metadata

New completion items store Rig 0.44's native provider item in
`providerMetadata.rigNative`, without the text or arguments that the item's
`text` and `input` fields already hold. Every completion item also records the
turn's `providerMetadata.origin`. Older clients reading these transcripts are
not supported.

Transcripts written by released clients use other `providerMetadata` fields.
When an item has no `rigNative`, the reader in `transcript/history.rs` rebuilds
the native item from them:

- Text: `openai_responses` extras become a native message item. `message_id`
  becomes its ID, `phase` stays on the item, and other extras such as
  `annotations` move to its content part.
- Tool calls: `openai.itemId` becomes the item ID, falling back to `callId`.
  `toolCallAdditionalParams` (or the whole metadata object when it is absent)
  supplies extra fields, and `signature` supplies the signature.
- Turns without `origin` are assigned the selected model's origin by
  `assign_unidentified_legacy_history_origin`. Known origins are never
  overwritten.

Keep these fallbacks until a versioned migration rewrites all stored local
JSONL and Convex transcripts.

Reasoning items use the same format for new and released clients: summary text,
`openai.itemId`, one encrypted payload in `openai.reasoningEncryptedContent`,
and `reasoningIssuer`. A missing issuer means `openai`, which is the released
default. Only OpenAI reasoning becomes a native reasoning item, so ciphertext
is never replayed to another provider. Keep the missing-issuer default until
the same migration supplies the issuer.

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

Sprocket's `StatelessResponses` wire only sets `store: false`. Rig 0.44 requests
encrypted reasoning and filters stateless reasoning without ciphertext.
Summary-only reasoning cannot be replayed without server storage. Function
call IDs continue to pair tool results; existing transcript formats remain
unchanged.

Remove this wire wrapper once Rig exposes an equivalent stateless Responses
configuration and the BYOK and SIWC multi-turn replay regressions pass natively.

### Rig developer messages

Rig 0.44's message type has no developer role. Sprocket represents application
instructions such as the handoff and continuation prompts as Rig system
messages. `DeveloperResponses` in `openai.rs` keeps them in `input` and
rewrites their role to `developer` on gateway, BYOK, and SIWC routes. Base
instructions stay in the top-level `instructions` field, and a late
instruction stays at its position, so the request prefix before it is
unchanged and the provider's prompt cache still matches. Stored transcripts are
unaffected. Remove this mapping when a released Rig version supports developer
messages natively and these tests pass without it:
`siwc_body_keeps_late_application_instructions_as_developer_messages`,
`completion_and_stream_use_the_refreshed_credential`, and the handoff request
assertions in `context_handoff/integration_tests.rs`.

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

### Retired exec_cmd workdir

New Rust agents run `exec_cmd` in the thread's cwd, set by `set_cwd`, and no
longer advertise a `workdir` argument. `vExecCommandPayload` keeps an optional
`workdir` so released agents can still dispatch it and stored jobs still
validate. The UI keeps showing `(cwd …)` for historical calls that carry it.
Rust argument parsing ignores the field when old history is replayed.

Keep the optional validator field and the UI label permanently because
transcript history records the original calls. Released agents ignore the new
optional `cwd` in run context responses, and threads without a saved `cwd`
start at the workspace root, so no stored-data rewrite is needed.

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

Supported agents advertise `exec_cmd`, `control_cmd`, `poll_cmd`, and
`poll_question`. The retired `exec_command`, `control_command`, `poll_command`,
`write_stdin`, and `await_question` names remain accepted only in stored-history
validators and UI rendering. Keep those historical shapes permanently.

All five command/question tools default to 10-second execution waits. Positive
poll waits clamp to 10–270 seconds, and pending zero-wait polls have a 10-second
cooldown. Current question results omit question text/options; only
`ask_question` returns `questionId`. Result validators also retain historical
question text/options and poll IDs for released agents and transcript history.

### Terminal transcript reconciliation

Reconciliation preserves existing settled-tool display output and historical
section assignments when the executor job has no section metadata. Migrated job
results must not rewrite conversation history.

### Project-owned artifacts

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

Removal gate: after production scans confirm every applicable subscription has
the projection fields and access phase, and expiry checks are rescheduled, the
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

#### Retired weekly usage limits

Usage is metered only against the monthly limit. `usage.getMyUsage` reports
each meter's `used`, `limit`, and `resetsAt` directly. It also keeps a
`windows` array holding a single `monthly` entry, because released usage pages
iterate that array. Weekly rate-limiter rows are no longer read, and the 62-day
retention job removes them.

Removal gate: drop `windows` from `vMyUsage` after released clients that read
it age out.

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
ChatGPT (SIWC). `getMyConfiguration` keeps its shape for supported clients and
reports `chatgpt: false` and `chatgptModelIds: null`.
Stored `completionProvider: 'chatgpt'` rows on threads and runs keep their
validator and stay readable; `completionProviderIds` retains `chatgpt`.
Keep `chatgpt` in `completionProviderIds` and the run and thread validators
permanently: local SIWC runs use the same provider ID as historical Codex runs.
The `getMyConfiguration` ChatGPT fields can go once no supported client reads them.

### Calendar usage windows

Dodo subscriptions may omit `billingPeriodEnded` and `billingPeriodCheckId`. The clock check still enforces their access deadline. `backfillSubscriptionExpiry` schedules a database update at each existing Dodo deadline, or marks an elapsed period immediately, so subscribed queries refresh without changing provider status. An hourly cron starts or resumes the migration. Operator grants remain unchanged. Remove the backfill and its cron after it has completed on every deployment. The fields stay optional while operator grants exist.

Old rate-limiter rows use seven-day or thirty-day windows with randomized starts. The current quota reader carries usage from an old row into the current UTC calendar window only if the old window began inside that calendar window. The old rows do not record charge timestamps, so usage from a window that began before the new calendar boundary cannot be safely attributed to the current window. On first charge, the current window records eligible old usage along with the new charge. New paid terms never inherit an old window. Existing operator-managed subscriptions may omit billing dates and continue to use calendar months; Dodo subscriptions created by the new webhook persist their billing dates.

Remove the old rate-limiter read path once every deployment has been running calendar windows for at least 30 days. Old component rows are removed by the 62-day retention job. Leave the optional subscription fields in place until any older subscription rows have billing dates or have ended.

### Retired repository rekey calls

Deployments may have queued `artifacts.continueRekey` jobs. The function is a
no-op and must not move artifacts when a checkout's remote changes. Remove it
after a scheduler scan confirms no queued continuation jobs remain.

### Completion provider defaults

Released clients do not send `completionProvider`, and existing thread and run
rows do not contain it. Convex and the Rust agent treat a missing value as
`spikonado`. Keep the field optional until released clients have aged out and a
migration has written `spikonado` to every older row. Then require the field and
remove the defaults.

### Descendant thread working counts

`threads.subtreeSummaryForThread` retains its original fields and adds
`workingDescendantCount`. The legacy `descendantStatusCounts` response derives
`running` from the working count and `completed` from the remaining total, with
other buckets zero. Released inbox clients combine non-running descendants into
Completed; queued descendants now also appear there. Remove this response shim
and validator only after those clients are outside the supported upgrade window.
Keep the total counter for expansion and inactive subagent labels.

### Completed migration records

The legacy-field, project-artifact, and hierarchy backfills completed in
production. Their runners and crons are removed. `migrationSchedules` retains
their completion records. Remove that table after an operator deletes or
archives those records on each deployment. Cleanup verification is read-only.

Stored transcript fallbacks below have separate data gates. A completed
migration can leave orphaned tool parts or unavailable command inputs unchanged.

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

#### Historical screenshot tool

`screenshot_url` is gone from the agent. Released agents that still offer it
create the job through `beginToolJob`, so the completion keeps its tool
invocation. Their `firecrawlRequests:start` call with `kind: 'screenshot'`
then fails with "This tool is no longer supported.", and the agent fails the
job with that error. Stored jobs and their cached images keep loading. Move the
kind to the historical kinds once those agents age out. The stored validators
stay permanently so history remains readable.

#### Mandate setup email

Mandate setup jobs written through v0.3.2 may contain `payload.userEmail`.
`vMandateSetupPayload` accepts that field for stored jobs. The completed
backfill removed it from migrated payloads. Remove the stored field after a
full production scan confirms no mandate setup payload carries it.

Early `mandate_status` results may also omit `description`, so the stored result
validator keeps that field optional. Current status calls always return it.
There is no source to backfill the missing descriptions from, so that variant
stays permanently.

#### Web tool result fields

Stored `scrape_url` results may contain `truncated`. Results written before the
Firecrawl integration may omit `summary` and `images`. The validators accept
both shapes so executor history and local JSONL transcripts remain readable.
The completed result backfill dropped `truncated` and supplied missing summary
and image fields. Remove these Convex variants after a full production scan
confirms every retained result uses the current shape. Local readers stay
permissive for historical JSONL.

Current scrapes return `outline` and optional `highlights` instead of
`summary`. The result validators keep `summary` optional for stored results.
A stored summary cannot be turned into an outline, so that field stays
permanently.

#### Historical skill results

`read_skill` returns complete bodies and no longer emits `truncated`.
The stored result validator still accepts that optional field for released
clients and historical results. Remove it only after those clients age out and
stored results are migrated. Local transcripts must continue accepting it.

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

Historical sectionless jobs still need terminal transcript writes during
reconciliation. Keep that internal fallback until those jobs are reconciled;
new jobs require a section key.

#### Attachment metadata and cache layout

Historical prompt attachments may contain `imageUploadId`; current writes use
only `storageId`. Convex readers accept the old field and remove it from
projected responses. The local user-level blob directory fallback was removed;
new uploads use only the thread directory. The attachment backfill completed.

Remove the Convex reader after old Convex rows have aged out or been rewritten.

#### Completion timing

Historical completion items and local JSONL records may omit `startedAt` and
`completedAt`. Readers preserve those records without inventing timing. Current
Convex writes normalize missing values to `null`. The timing backfill completed,
but live completion inputs still allow missing provider timestamps.

Historical completion bodies may omit `streamId`, and older local transcript
parts may omit `createdAt`. Readers leave stream identity and tool-event timing
unknown when those fields are absent. Stream identity cannot be reconstructed
after the fact, so that variant stays permanently. Input validators may remain
optional when current model providers do not supply a timestamp.

#### Tool invocation IDs

Historical tool parts use `jobId` and source keys of the form `tool:<jobId>`.
Current parts use `toolInvocationId` and phase-specific source keys. Readers use
`jobId` as the fallback pairing key, and `executorJobs.toolInvocationId` remains
optional for old jobs. The completed backfills filled job IDs and resolved
tool-part IDs through retained jobs. Orphaned parts were skipped. Remove these
Convex fallbacks only after a full scan confirms every job and tool part has an
invocation ID and no tool part carries `jobId`. Local history readers stay.

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

The completed command-input backfill filled absent inputs from retained jobs,
pairing by run, invocation ID, thread, and tool kind. Retire the shared `jobId`
pairing shim under the Tool invocation IDs gate above.

Until a full data scan confirms no recoverable gaps, command transcript retries hydrate an existing
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
