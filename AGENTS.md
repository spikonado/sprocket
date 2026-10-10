# AGENTS.md

## Project overview

- Sprocket is an agentic platform that streamlines hardware and software development.
- The goal is to make the world's best platform for agents and humans to develop apps, robots, devices, and the systems that glue them together.
- Sprocket should work across different hardware platforms, operating systems, and Sprocket's own cloud for hardware and software development.

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

## Maintaining code

- Don't be afraid to completely refactor existing code to improve on any of the priorities.
- Make sure that changes are made in all the layers of the app when needed.
- Ship breaking changes with backwards compatibility for already-released clients, their sprocket data-dir, and data in the Convex deployment.
- Record every shim in `BACKWARDS_COMPATIBILITY.md` with its removal gate.
- For the above point, remember that the Rust server and the UI that connects with it can't have different versions.
- Include data migrations in the PR that introduces the breaking change instead of leaving debt behind.
- Remove compat only once that gate passes (clients age out, or a migration rewrites the data).

## PR Workflow

- Unless requested, PRs should be made only against the default branch and should not be a draft.

1. When requested, push code and make a PR. The PR title should have the same format as past PR titles. Ensure that your branch is updated with the latest main.
2. Wait for the Greptile AI code review CI to complete and give its review of your changes.
3. Fix any relevant issues found by it:
   - These can be inline comments on the PR or somewhere above "Important Files Changed" in the PR description.
   - It often happens that some of the issues reported are false positives, outdated, not relevant, etc.
   - Don't spend any energy on these; skip them and explain your reasoning in the inline thread or, for an issue in the PR description, in a top-level PR comment.
4. Commit and push the code -> this time without asking.
5. You should loop steps 2-4 until Greptile gives you a 5/5 confidence score or there are no remaining actionable issues. Comment `@greptileai review` when it doesn't start reviewing automatically; if the score remains below 5/5 with no actionable issues, explain why and stop.
6. Clean up any worktrees and branches you created for this PR when you are done.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
