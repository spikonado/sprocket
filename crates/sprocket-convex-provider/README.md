# sprocket-convex-provider

`sprocket-convex-provider` adapts Convex-backed model completion to Rig's
completion traits. It lets the Rust agent use Rig's normal multi-turn loop while
provider credentials, model selection, rate limiting, and response persistence
remain in the cloud backend.

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the end-to-end run flow.

## Role in the system

The adapter translates Rig history, tool schemas, provider options, and usage
into a Convex action request. It translates the result back into Rig assistant
content and streaming events.

The Convex action persists live output for the web UI. The Rust side receives
the completed event sequence so Rig can continue its local tool loop without
becoming the source of truth for the transcript.

## Design constraints

- Authentication is supplied by the local server through an asynchronous token
  callback.
- Provider-specific reasoning and tool metadata must survive history replay.
- Concurrent Convex operations must not be serialized behind a long model call.
- A superseded stream is treated as stale ownership rather than a model
  failure.
- Wire-format changes must be coordinated with the Convex completion action.

The supported crate interface is re-exported from `src/lib.rs`. Transport and
Rig integration live in `client.rs`; history conversion lives in `messages.rs`.

## Validation

```sh
cargo test -p sprocket-convex-provider
bun run test
prek run -a
```

Validate Convex functions as well when the wire contract changes.
