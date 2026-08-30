# Convex backend

Convex owns durable application state and authorization. Browser calls use the
WorkOS identity configured in `auth.config.ts`. Persisted ownership uses the
canonical WorkOS token identifier returned by Convex, not the raw WorkOS
subject.

## Local executor authentication

After browser authentication is established, `sessionCredentials.issue`
creates a credential for that browser/local-server pairing. The browser sends
the initial `{ sessionId, userId, current, next }` ticket to the paired Rust
server. Only hashes are stored in Convex.

Rust rotates the ticket every five minutes. Each successful rotation promotes
`next` to `current`, and Rust generates a new `next`. Convex accepts the current
or immediately previous secret for authorization, making a lost rotation
response retryable. A session expires when it has not successfully rotated for
ten minutes. Sessions are isolated by `sessionId`, so multiple local servers
for one user do not invalidate each other.

Identity-sensitive local-executor calls include the session ticket and must
still check ownership of the target resource. Calls already scoped to one run
continue to use that run's `executionSecret`; the session ticket does not
replace capability authorization.

Released clients may still forward a WorkOS JWT to the local server. Keep that
fallback until the removal gate in `BACKWARDS_COMPATIBILITY.md` is met. Signing
out does not actively revoke a session ticket yet, so its authority can remain
for at most the ten-minute expiry window. Expired rows are currently retained.

## Development

From `apps/web`, run:

```sh
bun run check
bun run lint
bun run test
```

Generate `_generated` API types with the Convex CLI against a configured
deployment; do not hand-edit generated runtime files.
