# sprocket-agent

`sprocket-agent` owns the local lifecycle of an agent run. It coordinates
durable run state in Convex, streams completions through the AI gateway, and
exposes local workspace tools.

It is used by `sprocket-server` and depends on
[`sprocket-convex`](../sprocket-convex) and
[`sprocket-workspace`](../sprocket-workspace/README.md).

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the distributed run protocol.

## Run lifecycle

An agent run:

1. creates or recovers durable run state;
2. resolves the workspace and loads applicable instructions;
3. reconstructs prior model history;
4. acquires and renews ownership of the run;
5. posts OpenAI Responses completions to the AI gateway and runs local tools; and
6. records a terminal result.

Creation is retryable through the submission identifier. The run claim prevents
an old worker from executing tools or finalizing after ownership has moved.
Failure paths attempt to reconcile partially created or claimed runs so durable
state does not remain indefinitely active.

## Built-in skills

Built-in skills live in [`sprocket-workspace/skills`](../sprocket-workspace/skills)
and are discovered at run time with project and user skills. See that crate for
the on-disk layout.

## Tools

The agent currently offers command execution, command-session input, workspace
patching, skill loading (`read_skill`), web search, and web-page scraping. Every
tool call is wrapped in a durable executor-job record and observes run
cancellation while work is active.

Command execution and patch operations both run with the local Sprocket
process's permissions. Web search and scraping enqueue a Convex Workpool job
(`webToolPool`) that runs Exa and Context.dev actions, keyed by deployment-side
environment variables (`EXA_API_KEY`, `CONTEXT_DEV_API_KEY`); only the results
flow back through the executor job. Released agents that still call the public
`webTools` actions wait on that same job.

## Main areas

- `run.rs`: ownership, preparation, and finalization.
- `provider.rs`: gateway completion loop, transcript sink, and provider outcomes.
- `compaction.rs`: in-loop context compaction via a normal Responses call.
- `history_json.rs`: Rig history JSON for the compaction summarizer.
- `tools.rs`: model tools and durable job coordination.
- `convex.rs`: run-control communication.
- `types.rs`: history and context wire types.
- `hooks.rs`: tool-call correlation, invalid-call handling, and OpenAI additional params.

Changes to run state, history, cancellation, or tool shapes usually require a
matching Convex change.

## Validation

```sh
cargo test -p sprocket-agent
bun run test
prek run -a
```
