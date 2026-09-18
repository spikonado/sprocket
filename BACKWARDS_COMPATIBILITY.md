# Backwards compatibility

We ship breaking changes ahead of our users' installed clients and keep the old behavior working until those clients age out. That debt is easy to accumulate and easier to forget. This file lists every backwards-compatibility layer we currently ship, what it protects, how to remove it, and the signal that says removal is safe. When a removal PR merges, remove its entry from this document.

Older clients, servers, UIs, and their Sprocket data directories are no longer
supported. The compatibility layers for them were removed together, along with
the completed Convex migrations and the code that only existed to read their
stored shapes:

- Retired Convex functions that returned the "no longer supported" upgrade
  message (`agentRuntime.createRun/finalizeRun/reopenRun/saveContextCompaction`,
  `chat.latestRunForThread`, `completion.*`, `messages.*`, `modelCatalog.get`,
  `projects.*`, `threads.create/listMine/archive/restore/rekeyRepository`,
  `uiPreferences.setLastThread/setPaymentsEmail`,
  `webTools.scrapeUrl/webSearch/scrapeForTool/screenshotForTool`,
  `browserAgent.*`, `machineSessions.*`, `machines.register`).
- The `threads:renameForLocalCache/archiveForLocalCache/restoreForLocalCache/
rekeyRepositoryForLocalCache` aliases. Local servers call `rename`, `settle`,
  `unsettle`, and the now-live `rekeyRepository` directly.
- The `transcriptProtocol` and `includeOutput` fallbacks. Agents always send
  `transcriptProtocol: 2` and `includeOutput: true`; the finalization result is
  always the structured `{accepted, outcome}` object.
- The `parse_file` URL payload and the mandate-setup `userEmail` argument.
  Payload validation rejects them.
- The production-rollout cleanup migrations, the write-time transcript-section
  migration, the `migrationSchedules` table, and their crons. The schema no
  longer contains `projects`, `projectConnections`,
  `threadTranscriptMemberships`, `threadRecords.projectId`,
  `threadRecords.contextSummaryThroughRunId`, `threadRecords.status` as
  optional, run catalog/transport/prompt-message fields, thread-usage ledger
  marker fields, transcript-state `workThrough`/`migratedAt`, optional
  transcript `work`, optional section `sectionOrdinal`/`displayOrder` and
  `linkedParts`, `imageUploads.messageIds`, or executor-job `projectId`/
  `cloudWorkPool`/optional `toolInvocationId`.
- Stored executor-job validators for `create_artifact`/`update_artifact`,
  Browserbase tools, legacy command results, `scrape_url` `truncated` and
  optional `summary`/`images`, `parse_file` URL sources, mandate-setup
  `userEmail`, and optional mandate-status `description`. Transcript validators
  for `imageUploadId`, optional `streamId`, and `jobId`/optional
  `toolInvocationId`.
- Transcript read fallbacks for legacy membership rows, `imageUploadId`
  stripping, `jobId` pairing, run-ID context cutoffs, and the reasoning reload
  filter. Section writes no longer keep membership entries; a retried part
  insert skips its section write because parts and sections commit atomically.
- Local data-directory migrations: unkeyed `project-attachments.json` records
  and their remote-identity inference, sessions without `localBrowser` (now
  required; old session files fail to parse and start empty), user-level blob
  attachment reads (the `blobs/` store, its upload index, and its purge are
  gone; only thread-local `attachments/<storageId>/` and
  `pending-attachments/` remain), and local `tool:<jobId>` transcript parts.

## CLI authentication and run control

CLI clients send their exact semantic release version to local `/api/cli/*`
endpoints. The local server rejects every mismatch, including canary identifiers
and dev commit hashes, so a newly installed CLI cannot reuse a stale server.

CLI discovery and bootstrap proofs bind to a random server-process ID. The CLI
never sends the reusable pairing credential over HTTP. CLI sessions stay in
memory and cannot resume after a server restart. Bound persisted browser
sessions keep working.

Profiles without a credential-store selection continue using the existing
deployment-and-data-directory-scoped keyring entry. No credentials are copied to
file storage automatically. The keyring default has no removal gate; it remains
the default storage backend.

Older apps do not subscribe to `/api/auth/changes`; their existing session-token
reads still observe the shared login. Keep those endpoints until all supported
installed apps use the session-change subscription. Native tokens remain
restricted to the existing local-app endpoint; CLI control uses local pairing
sessions and never returns refresh tokens.

New servers take an exclusive data-directory lock. Separate profiles must use
separate data directories.
