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

- Only run `prek run -a` and other small tests locally. Don't run any rust compilations or checks.
- Prek covers formatting and linting.
- Aside from these, look at the CI on GitHub when you open a PR.

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

### Backwards compatibility

- The Rust server, the UI, and the CLI ship as one version, so changes between them need no compatibility.
- Ship breaking changes with backwards compatibility for the Convex API that released clients call, their sprocket data-dir, and data in the Convex deployment.
- Older PR builds/dev builds don't count as released clients for backwards compatibility.
- A shim is temporary code with a removal gate. Record each shim in `BACKWARDS_COMPATIBILITY.md` with its gate, and add historical formats kept forever to its permanent list. Permanent defaults, SDK workarounds, and fields introduced by the current PR need no entry.
- Include data migrations in the PR that introduces the breaking change instead of leaving debt behind.
- Remove compat only once that gate passes (clients age out, or a migration rewrites the data).

## PR Workflow

- Unless requested, PRs should be made only against the default branch and should not be a draft.
- After a PR is made, don't perform any code review using subagents; let Greptile review the code.

1. When requested, push code and make a PR. The PR title should have the same format as past PR titles. Ensure that your branch is updated with the latest main.
2. Wait for the Greptile AI code review CI to complete and give its review of your changes.
3. Fix the actionable issues found by it:
   - These can be inline comments on the PR or somewhere above "Important Files Changed" in the PR description.
   - A finding is actionable when it shows the change breaks behavior the task needs.
   - When a finding comes from a mechanism the task doesn't need, remove the mechanism.
   - Findings that add a mechanism, UI, or handling for a scenario that doesn't occur in real use, along with false positives and outdated findings, get a reply with your reasoning in the inline thread or, for an issue in the PR description, in a top-level PR comment.
4. Commit and push the code -> this time without asking.
5. You should loop steps 2-4 until Greptile gives you a 5/5 confidence score or there are no remaining actionable issues. Comment `@greptileai review` when it doesn't start reviewing automatically; if the score remains below 5/5 with no actionable issues, explain why and stop.
6. Clean up any worktrees and branches you created for this PR when you are done.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
