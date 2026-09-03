# sprocket-server

`sprocket-server` is the boundary between browser-controlled requests and the
user's machine. It provides the local API, serves the web application when
needed, owns this machine’s folder list, and owns local agent tasks.

The crate is a library used by `sprocket-cli` and also provides a small
standalone server binary. See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the
full process topology.

## Responsibilities

- Establish local browser or desktop authorization.
- Own the installed client's native WorkOS session and refresh its access
  tokens for machine-side Convex calls.
- Resolve, attach, and revalidate local workspaces.
- Start agent runs with the Rust-owned WorkOS token fetcher.
- Detach accepted launches from browser requests and hand active work a
  run-scoped execution capability.
- Serve the local API and optional static web build.
- Persist only machine-local state.

## Boundaries

The server does not store conversations or model credentials. Durable user,
thread, run, and transcript state belongs to Convex. The server keeps local
pairing/session data and this machine’s folder list (`workspacePath` plus
`repositoryKey`). Convex threads store `repositoryKey`; the web app groups
those threads onto local folders whose key matches.

Local authorization and cloud authentication are separate. A local session
permits access to machine-facing operations. Rust owns a WorkOS session for
agent runs and machine registration, separate from the renderer's AuthKit
session. Rust keeps the native access token in memory and stores its refresh
token in the operating system credential store. It scopes the credential by
Convex deployment and data directory so development and installed sessions do
not overwrite each other.

Rust loads the public WorkOS client ID on demand from the unauthenticated Convex
query `authBootstrap:getClientConfig`. Native auth failures do not block server
startup. The local loopback flow keeps PKCE, state, code exchange, and refresh
rotation in Rust; neither the authorization code nor native refresh token is
returned to the renderer.

Machine registration returns the canonical native user ID. Agent launch checks
it against the renderer's browser user ID and rejects mismatched accounts.
After run creation, the agent also uses a random capability whose hash is bound
to that run, so closing the browser does not interrupt active work.

This migration is partial. Thread cache and transcript-related routes still use
browser tokens in several local API requests. Do not treat a paired local
session or caller-supplied user ID as proof of cloud ownership.

The server binds locally by default. Static serving and API-only operation are
two configurations of the same router rather than separate applications.

## Main areas

- `auth.rs`: local pairing and HTTP-only browser sessions.
- `native_auth.rs`: native WorkOS login, credential persistence, and token
  refresh.
- `routes/auth.rs`: local session endpoints and the native loopback callback.
- `project_attachments.rs`: local folder list (`workspacePath` + `repositoryKey`).
- `routes/`: HTTP boundaries for configuration, workspaces, auth, and agents.
- `static_dir.rs` and `static_files.rs`: web-build discovery and serving.
- `config.rs`: process configuration.
- `lib.rs`: shared state, router construction, and server lifecycle.

Reusable filesystem behavior belongs in `sprocket-workspace`; run behavior
belongs in `sprocket-agent`.

## Validation

```sh
cargo test -p sprocket-server
prek run -a
```
