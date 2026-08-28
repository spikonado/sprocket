# sprocket-server

`sprocket-server` is the boundary between browser-controlled requests and the
user's machine. It provides the local API, serves the web application when
needed, owns this machine’s folder list, and owns local agent tasks.

The crate is a library used by `sprocket-cli` and also provides a small
standalone server binary. See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the
full process topology.

## Responsibilities

- Establish local browser or desktop authorization.
- Resolve, attach, and revalidate local workspaces.
- Start agent runs with a fresh authenticated cloud user token.
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
permits access to machine-facing operations; a WorkOS token identifies the user
to Convex while the run is created. After creation, the agent uses a random
capability whose hash is bound to that run, so closing the browser does not
interrupt active work.

The server binds locally by default. Static serving and API-only operation are
two configurations of the same router rather than separate applications.

## Main areas

- `auth.rs`: local sessions, pairing, and desktop browser sign-in.
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
