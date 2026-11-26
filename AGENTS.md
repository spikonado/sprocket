# AGENTS.md

## Project overview

- Sprocket is an agentic platform that streamlines hardware and software development.
- The goal is to make the world's best platform for agents and humans to develop apps, robots, devices, and the systems that glue them together.
- Sprocket should work across different hardware platforms, operating systems, and Sprocket's own cloud for hardware and software development.
- Assume that Sprocket runs on a machine owned by a single user. Machine resources such as installed tools, browsers, daemons, and caches belong to the machine; user IDs are for auth checks.

### Crates

Here's what each Rust crate is for; you may create more crates when needed.

- `sprocket-agent`: model providers, the agent run loop, and agent tools.
- `sprocket-cli`: the `sprocket` CLI, a client of the local server.
- `sprocket-convex`: the Convex client.
- `sprocket-host`: machine-side services such as credentials, command sessions, run recovery, sync, and updates.
- `sprocket-server`: the HTTP server for the UI and CLI.
- `sprocket-transcript`: transcript storage, sync, and downloads.
- `sprocket-workspace`: local files, git, commands, patches, artifacts, and skills.

## Available testing commands

- `prek run -a` covers formatting and linting.
- Don't run long compilations locally for things that can be verified through CI.

### Nix environment

It provides all dependencies/tools you may need. Use it through `nix develop -c <command>`.

## Priorities in order

1. Reliability of code -> Behavior should be predictable under load and during failures -> This includes our servers and the user's system
2. Maintainability of code
3. Performance of code

All of these are core priorities; try your best to achieve all of them without having to make trade-offs.

Reliability comes from fewer moving parts. Add recovery, retries, validation, or idempotency when the task needs them.

## Maintaining code

- Don't be afraid to completely refactor existing code to improve on any of the priorities.
- Put Rust unit tests for `foo.rs` in `foo/tests.rs`, declared as `#[cfg(test)] mod tests;`. Test-only helpers live there too, or in `foo/test_support.rs` when other modules' tests use them.
- Before adding a Convex function, table field, or index, check whether an existing query or mutation already serves the need. Store only the state the feature needs and derive the rest.
- Make sure that changes are made in all the layers of the app when needed.

### Tests

- Before adding a test, name the product failure it catches and check whether existing coverage already catches it. Extend an existing case when possible.
- Keep regression checks for auth, billing, recovery, concurrency, transport, parsing, filesystem behavior, and data integrity. Use verify skills for appearance and ordinary UI wiring.
- Test Sprocket's behavior, not library guarantees, copied constants or schemas, direct fixture insert/read pairs, or implementation formulas. Assert the protocol constraints that matter instead of snapshotting whole schemas.
- Keep tests local and deterministic. Seed caches and dependencies instead of waiting on real services and retries.
- During review and cleanup, remove new tests that don't meet these rules.

### Backwards compatibility

- The Rust server, the UI, and the CLI ship as one version, so changes between them need no compatibility.
- Ship breaking changes with backwards compatibility for the Convex API that released clients call, their sprocket data-dir, and data in the Convex deployment.
- Older PR builds/dev builds don't count as released clients for backwards compatibility.
- A shim is temporary code with a removal gate. Record each shim in `BACKWARDS_COMPATIBILITY.md` with its gate, and add historical formats kept forever to its permanent list. Permanent defaults, SDK workarounds, and fields introduced by the current PR need no entry.
- Include data migrations in the PR that introduces the breaking change instead of leaving debt behind.
- Remove compat only once that gate passes (clients age out, or a migration rewrites the data).

## PR Workflow

- Unless requested, PRs should be made only against the default branch and should not be a draft.
- When requested, push code and make a PR. The PR title should have the same format as past PR titles. Ensure that your branch is updated with the latest main.
- Clean up any worktrees and branches you created for this PR when you are done.
