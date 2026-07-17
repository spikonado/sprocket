# sprocket-agent

`sprocket-agent` owns the local lifecycle of an agent run. It coordinates
durable run state in Convex, drives Rig, and exposes local workspace tools.

It is used by `sprocket-server` and depends on
[`sprocket-convex-provider`](../sprocket-convex-provider/README.md) and
[`sprocket-workspace`](../sprocket-workspace/README.md).

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the distributed run protocol.

## Run lifecycle

An agent run:

1. creates or recovers durable run state;
2. resolves the workspace and loads applicable instructions;
3. reconstructs prior model history;
4. acquires and renews ownership of the run;
5. alternates between model completions and local tools; and
6. records a terminal result.

Creation is retryable through the submission identifier. The run claim prevents
an old worker from executing tools or finalizing after ownership has moved.
Failure paths attempt to reconcile partially created or claimed runs so durable
state does not remain indefinitely active.

## Tools

The agent currently offers command execution, command-session input, and
workspace patching. Every tool call is wrapped in a durable executor-job record
and observes run cancellation while local work is active.

Command execution has full local process permissions. Patch operations are
confined to the workspace by `sprocket-workspace`.

## Main areas

- `run.rs`: ownership, preparation, and finalization.
- `provider.rs`: Rig agent loop and provider outcomes.
- `tools.rs`: model tools and durable job coordination.
- `convex.rs`: run-control communication.
- `types.rs`: history and context wire types.
- `hooks.rs`: tool-call correlation and invalid-call handling.

Changes to run state, history, cancellation, or tool shapes usually require a
matching Convex change.

## Validation

```sh
cargo test -p sprocket-agent
bun run test
prek run -a
```
