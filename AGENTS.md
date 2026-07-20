# AGENTS.md

## Project Overview

- Sprocket is an agentic platform that streamlines robotics development.
- It's goal is to give its users and AI agents the best possible experience when developing robots and robot apps. They should be able to ship across the entire robotics stack much faster than ever before.
- Sprocket should work seamlessly across different hardware platforms, operating systems, and Sprocket's own cloud for robotics development.

## Available Testing Commands

- `bun run build`
- `bun run test`
- `cargo test`
- `prek run -a` -> This covers ALL formatting and linting

If you are a subagent, don't run any of these.

### Nix Environment

It provides all dependencies/tools you may need. Use it through `nix develop -c <command>`.

## Priorities in Order

1. Reliability of code -> Behavior should be predictable under load and during failures -> This includes our servers and the user's system
2. Maintainability of code
3. Performance of code

All of these are core priorities; try your best to achieve all of them without having to make tradeoffs.

## Maintaining Code

- Don't be afraid to completely refactor existing code in order to improve on any of the priorities.
- Make sure that changes are made in all the layers of the app when needed.

## Writing Code

- Deleting code, often fixes more problems than writing code does. Sometimes writing too much code introduces problems.
- Specifically for gpt-5.6-sol: You often end up writing more code than needed, especially tests. Please don't do this.

## Subagents

### Working on Stuff - Only for Main Agents

- Feel free to commit, branch, and spin up worktrees as you please. Don't push before asking.
- Do the deep dives and figure out what needs to be done and delegate the rest accordingly and as needed to subagents.
- Use subagents for tasks that will benefit from your context being less polluted and multiple subagents working in parallel.
- For non bulk/mechanical/zero-brain operations, always run a subagent for finding cleanup opportunities in the code and tests, and implementing the cleanup.
- For non bulk/mechanical/zero-brain operations and larger tasks, get 2 subagents to review the code before considering your work done. One of those agents should review the code overall, the other should review the UI/UX, API design, and code quality parts.
- When getting code reviewed by subagents in a loop, use gpt-5.6-sol as the review subagent for a max of 3 reviews. After this, rely on some other model for the review subagent.

#### PR Workflow

- Unless requested, PRs should be made only against the default branch and should not be a draft.
- After a PR is made, don't perform any code review using subagents, let Greptile review the code.

1. When requested, push code and make a PR. The PR title should have the same format as past PR titles. Ensure that your branch is updated with the latest main.
2. Wait for the Greptile AI code review CI to complete and give its review on your changes.
3. Fix any relevant issues found by it:
   - These can be inline comments on the PR or somewhere above "Important Files Changed" in the PR description.
   - It often happens that some of the issues reported are false positives, outdated, not relevant, etc.
   - Don't spend any energy on these and skip them.
4. Commit and push the code -> this time without asking.
5. Loop on 2-4 till there are no more issues to fix.
6. Cleanup any worktrees and branches you created for this PR when you are done.

### Subagent Prompting

To main agents:

- Don't put any parts of your system prompt, AGENTS.md, etc. in the subagent prompts.
- Tell the subagent that it is a subagent.

To subagents:

- Never create your own subagents.

### Picking the Right Models for Subagents

- Higher rankings = better. (higher ranking on the costs indicates lower cost of the model)
- Cost reflects what the model costs me from subscriptions, credits, tokens it uses, etc. not its actual list price.
- Intelligence shows how hard of a problem you can hand the model unsupervised.
- Taste covers UI/UX, code quality, code cleanup ability, and API design.

| model         | cost | intelligence | taste | reasoning to use | CLI to use             |
| ------------- | ---- | ------------ | ----- | ---------------- | ---------------------- |
| gpt-5.6-sol   | 8    | 9            | 6     | low              | codex                  |
| fable-5       | 5    | 8            | 9     | low              | claude or cursor-agent |
| gpt-5.6-terra | 9    | 7            | 5     | medium           | codex                  |
| grok-4.5      | 10   | 6            | 7     | high, fast       | cursor-agent           |

How to apply:

- Only use the models listed above.
- If you have a tool available for spawning subagents, never use that. Instead use the CLI of a specific coding agent harness directly.
- If a cheaper model's output doesn't meet the bar, rerun/redo the work with a better model without asking.
- The produced code meeting the priorities in "Priorities in Order" is much more important than what it costed.
- For bulk/mechanical/zero-brain operations, always use the cheapest model first and only switch to a better model if the output doesn't meet the bar.
- For user-facing UI/UX and APIs, use a model with good taste (>=7). If making those UIs/APIs is highly complicated, get a model with higher intelligence to complete the work after the core UI/API has been decided by the model with good taste.

## Cursor Cloud specific instructions

The startup update script already ran `bun install` inside the Nix dev shell, and the Nix store is prewarmed in the VM snapshot. Notes below are the non-obvious gotchas for this environment.

### Nix daemon (no systemd)

- This VM's init is `tini`, not systemd. The multi-user Nix daemon is auto-started from the agent's `~/.bashrc`. If a shell reports `nix` missing or `cannot connect to socket at '/nix/var/nix/daemon-socket/socket'`, start it once with:
  `sudo sh -c 'nohup /nix/var/nix/profiles/default/bin/nix-daemon >/tmp/nix-daemon.log 2>&1 &'`
- The Nix binary cache config in `flake.nix` (cachix) is ignored because this user isn't a trusted Nix user; everything is fetched from `cache.nixos.org`, so those warnings are harmless.

### Running toolchain commands

- Run every toolchain command as `nix develop --accept-flake-config -c <command>` (e.g. `nix develop --accept-flake-config -c bun run test`).
- Do NOT wrap it in a login shell (`bash -lc`). `~/.bashrc` prepends the system `cargo 1.83` to `PATH`, which lacks `edition2024` and breaks all cargo builds. Plain `nix develop -c ...` keeps the Nix toolchain (cargo/rustc 1.96, bun 1.3.x, node 24) first.

### Services and ports

- `nix develop --accept-flake-config -c bun dev` starts the whole dev stack: Rust API (`:7731`), an anonymous local Convex backend (`:3210`), and Vite (`:5173`). `bun dev:desktop` swaps Vite for Electron.
- `convex dev` (invoked by `bun dev`) provisions a fully local, no-account Convex deployment and writes `apps/web/.env.local`. The browser's `PUBLIC_CONVEX_URL` comes from the Rust server's `/api/config`, which `bun dev` points at the local backend via that `.env.local`.
- The local Convex push fails until deployment env vars exist. Set placeholders once (they persist in the local deployment): `cd apps/web && nix develop --accept-flake-config -c node node_modules/convex/bin/main.js env set WORKOS_CLIENT_ID <val>` and likewise for `CONTEXT_DEV_API_KEY` and `EXA_API_KEY`.
- Full sign-in and agent runs additionally require a real WorkOS AuthKit app (`WORKOS_CLIENT_ID`) and a model-provider key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY`) set on the Convex deployment. Without them the app renders the sign-in screen but cannot authenticate or run the agent.

### Local server (works fully offline)

- The Rust server can run standalone: `nix develop --accept-flake-config -c cargo run -p sprocket-cli -- serve --port 7731 --data-dir .sprocket-dev --api-only`.
- Pair a client by POSTing the credential from `<data-dir>/pairing-credential` to `/api/auth/bootstrap` (returns a session cookie), then use `/api/workspace/{browse,resolve,sessions}` for local filesystem access and workspace attachment.

### Dev-mode web UI caveat

- `bun dev`'s Vite browser bundle currently throws `ReferenceError: process is not defined` (from `apps/web/src/convex/lib/rateLimits.ts` value-importing `internalMutation` from `_generated/server.js`, which pulls `process.env` into the client via `+page.svelte` -> `settings-usage.svelte`). This shows a client-side "500 Internal Error" page.
- The production build tree-shakes that import, so `bun run build` output renders correctly. To view the UI, serve the build with the Rust server: `SPROCKET_STATIC_DIR=/workspace/apps/web/dist PUBLIC_CONVEX_URL=http://127.0.0.1:3210 nix develop --accept-flake-config -c cargo run -p sprocket-cli -- serve --port 17731 --data-dir .sprocket-web`, then open `http://127.0.0.1:17731/`.
