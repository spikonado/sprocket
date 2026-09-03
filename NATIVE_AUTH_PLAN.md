# Native WorkOS authentication

## Goal

Give the Rust server its own WorkOS session so machine-side work can authenticate to Convex without receiving access tokens from the web renderer.

## Requirements

### Native session

- Rust owns the PKCE verifier, authorization state, authorization-code exchange, refresh-token rotation, and Convex auth callback for the native session.
- Browser sign-in uses the system browser and a loopback callback bound to `127.0.0.1`.
- The WorkOS client is public. No client secret is shipped in the desktop app or CLI.
- Rust keeps access tokens in memory and persists only the credential needed to resume the session.
- Production builds store the refresh token in the operating system credential store. Development may use an explicitly documented fallback when no credential service is available.
- Refresh-token updates are persisted before the previous token is discarded.
- Sign-out revokes or clears the native session and removes its stored credential.

### Local API

- Local API clients authenticate with the existing paired, HTTP-only local session.
- Cloud-backed local endpoints derive the WorkOS user from Rust's native session.
- Requests no longer accept a WorkOS access token or trust a caller-supplied user ID for authorization.
- The local auth status reports whether native auth is configured and authenticated, plus enough user metadata for the renderer to detect an account mismatch.
- An account mismatch blocks machine-side cloud operations and presents a clear recovery path.

### Web app

- The hosted web app keeps its independent AuthKit session and direct authenticated Convex connection.
- The installed renderer starts and observes native sign-in through the local API. It never receives the native refresh token.
- Sign-out in the installed app clears both the renderer session and native session.
- Direct browser-to-Convex auth continues to use the framework auth adapter and token refresh callback.

### Convex authorization

- Public Convex functions derive caller identity from `ctx.auth` unless they use a narrowly scoped, validated capability.
- Reads and writes verify ownership or membership before returning or changing user data.
- Public functions have argument and return validators. Internal-only operations use internal functions.
- New ownership data uses `identity.tokenIdentifier` as the canonical identity key.
- Existing subject-keyed data remains readable during a documented migration. Any compatibility shim and removal gate goes in `BACKWARDS_COMPATIBILITY.md`.
- Machine and run capabilities remain random, scoped, revocable credentials. They do not become general user credentials.

## Delivery sequence

1. Add a native WorkOS session manager with PKCE, durable refresh-token storage, rotation, status, and sign-out.
2. Move the loopback callback and code exchange fully into Rust.
3. Give Rust services a shared authenticated Convex token fetcher and derive the native user from verified token claims or an authenticated Convex function.
4. Remove `authToken` and authorization-sensitive `userId` fields from local API contracts and renderer calls.
5. Update installed-app sign-in, mismatch handling, and sign-out. Keep hosted web auth independent.
6. Audit and harden all public Convex functions, then introduce the token-identifier compatibility migration.
7. Update operator documentation and validate focused tests, full Rust and web tests, builds, and repository linting.

## Acceptance criteria

- After one native sign-in, Rust can restart, refresh its WorkOS access token, and call authenticated Convex functions without an open renderer.
- No local API request body contains a WorkOS JWT.
- Changing a request's user ID cannot select another user's cloud or local data.
- Closing or reloading the renderer does not stop Rust token refresh or an accepted agent run.
- Native and renderer sessions for different users cannot perform machine-side cloud operations.
- Expired, revoked, malformed, and rotated credentials fail closed and have tests.
- The Convex auth and authorization audit has no unexplained public-function findings.
