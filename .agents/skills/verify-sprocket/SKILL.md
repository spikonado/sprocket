---
name: verify-sprocket
description: Verify Sprocket web app changes in the real dev app, run from the current worktree against the dev Convex deployment and driven with agent-browser. Use to prove a UI, Convex, or server change works, or when the user asks for screenshots, a live demo, or a tailnet URL.
---

# Verify Sprocket

Proof comes from the real app. Run the Rust API and Vite from this worktree against the dev Convex deployment, and drive them the way a user does. The user rejects mock pages and fake-data previews as proof. Build Rust locally when verifying. That overrides the AGENTS.md rule against local Rust compilations.

## Helpers

Set `V=$(git rev-parse --show-toplevel)/.agents/skills/verify-sprocket/scripts` once.

| Command                    | Does                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `$V/launch.sh`             | Installs bun deps, builds `sprocket-cli`, then runs `bun dev` in the foreground. Refuses when 5173 or 7731 is taken. |
| `$V/doctor.sh`             | Read-only health check. Exit 0 means the instance is worth driving.                                                  |
| `$V/app-url.sh`            | Maps the tailnet's port 5173 to Vite and prints the app URL.                                                         |
| `$V/ref.sh '<text>'`       | Prints the `@ref` of the first `snapshot -i` line containing the text.                                               |
| `$V/login.sh`              | Signs the profile's host in with a device code.                                                                      |
| `$V/stop.sh`               | Kills this worktree's leftover dev-port listeners.                                                                   |
| `$V/scratch-repo.sh [dir]` | Creates or reuses a remote-less git repo and prints its path. Default `/tmp/verify-sprocket-scratch`.                |

## Machine facts

- One instance per machine. The API always binds `127.0.0.1:7731`, and Vite binds `localhost:5173` with `strictPort`. When another worktree's instance holds them, ask the user before stopping it.
- Ports `17731` and `4321` belong to the user. `17731` is the installed Sprocket app, possibly the agent you run in. Leave both ports and their tailscale serve mappings alone.
- `bun dev` runs `convex dev`. That pushes this worktree's `apps/web/convex` to the shared dev deployment and sets the dev AuthKit homepage URL to `http://localhost:5173`.
- The shell exports the prod `PUBLIC_CONVEX_URL`, and the committed root `.env` compiles prod in as a fallback. Every Sprocket process needs the dev URL, `VITE_CONVEX_URL` in the gitignored `apps/web/.env.local` of the main checkout. The helpers pass it, and anything run by hand must too. A mixup signs the host into prod and registers this machine there.
- Shared across worktrees, so sign-in and the cold build happen once per machine:
  - `~/.sprocket-dev-verify`: the server profile, with host credentials and browser sessions.
  - agent-browser session and restore key `verify-sprocket`: the browser cookie bound to that profile.
  - `~/.cache/sprocket-verify-target`: the cargo build cache.

## Launch

Start `$V/launch.sh` as a background command session and keep its id. Read its raw output, since a `grep` or `tail` pipe buffers it.

A cold build takes about 15 minutes on this 4-core box. Incremental builds take seconds. Wait for any other agent editing `crates/` in this worktree to finish first.

Ready means these lines appeared and then `$V/doctor.sh` exits 0:

- `[api] Sprocket API is running at http://127.0.0.1:7731`
- `[web] ✔ ... Convex functions ready!`
- `[web]   ➜  Local:   http://localhost:5173/`

Vite's "Port 5173 is in use on a wildcard address" is tailscale serve on the tailnet IP and is harmless.

Web edits hot-reload. For Rust edits, run Cleanup step 2 and launch again.

## Doctor

Run `$V/doctor.sh` before the first drive, after any failed drive, and whenever anything looks off. Drive only after exit 0.

## Open the app

Drive the tailnet origin. It signs in with device codes the user approves on their own device. The `localhost` origin would need the user's AuthKit password typed into the headless browser.

```sh
APP=$($V/app-url.sh)
export AGENT_BROWSER_SESSION=verify-sprocket AGENT_BROWSER_RESTORE=verify-sprocket
agent-browser open "$APP"
agent-browser set viewport 1440 900
agent-browser wait --fn "document.querySelector('[aria-label=\"Open side panel\"]') || document.body.innerText.includes('Sign in to continue')"
agent-browser snapshot -i
```

- `AGENT_BROWSER_RESTORE` is the restore key itself. Keep both exports for every call: after an hour idle the browser closes, and the next command relaunches it with the cookie restored.
- `button "New thread"` in the snapshot means signed in. `heading "Sign in to continue"` means follow [features/sign-in.md](features/sign-in.md) first. Use the same `wait` after every reload, since `New thread` shows about a second before the rest of the shell.

## Drive

[features/README.md](features/README.md) indexes one recipe per feature. Read it before driving.

- `snapshot -i` gives refs. Plain `snapshot` also shows alerts, banners and errors.
- Take refs with `$V/ref.sh`, for example `agent-browser click $($V/ref.sh 'button "Files"')`. Dialogs show in plain `snapshot` only, while `snapshot -i` lists their controls.
- `click` has no right button. For a context menu, read the target's center from `agent-browser get box @eN`, then run `mouse move <x> <y>`, `mouse down right` and `mouse up right`. This also reaches rows inside shadow roots, such as the Files tree.
- A hot reload resets UI state such as the open side panel. Re-open it and re-take refs after each source edit.
- API checks go through the signed-in page: `fetch` in `agent-browser eval --stdin`, or `agent-browser network requests --filter /api/`. Plain `curl` to `/api/*` gets 403 or 401.

## Evidence

Proof goes in `OUT=/tmp/verify-sprocket/$(date +%Y%m%d-%H%M%S)-<feature>`, one per feature run, named after its feature file.

- Before and after each user action, run `agent-browser screenshot $OUT/NN-step.png` and `agent-browser snapshot > $OUT/NN-step.txt`.
- Every mutation gets a second view besides the screen: files in the scratch repo, `~/.sprocket-dev-verify/project-attachments.json`, network requests, the launch log, or the page after a reload.
- Drive only the user path. Use UI actions, never internal setters, test-only routes, or Convex functions called from the CLI.
- Open each screenshot with `parse_file` before describing it.
- Share images as WebP, since PNGs are about 1 MB: `nix shell nixpkgs#libwebp -c cwebp -quiet -q 70 -resize 1400 0 in.png -o out.webp`. The box has no ImageMagick, PIL or ffmpeg. Embed them in one HTML artifact with a stable filename, because the artifact title follows the filename.
- A user who wants to try it gets `$APP` and signs in there with their own device code.

## Cleanup

Stop only what this run started, by PID.

1. `agent-browser close`, which saves the restore state.
2. Terminate the launch command session, then run `$V/stop.sh`, which kills the `vite dev` that terminating leaves behind.
3. Reset the scratch repos: `git -C <dir> checkout -- . && git -C <dir> clean -fd` for `/tmp/verify-sprocket-scratch` and any other `$V/scratch-repo.sh` directory the run touched. Keep the directories. The app can't remove projects, so a deleted directory leaves a dangling project in `~/.sprocket-dev-verify`.
4. Keep `~/.sprocket-dev-verify`, the `verify-sprocket` restore state, `~/.cache/sprocket-verify-target` and the evidence in `/tmp/verify-sprocket/`. Keep the 5173 serve mapping too, since the stored sign-in belongs to that origin.

Run cleanup after failed attempts too, so the next launch finds free ports.

## Known limits

- Model replies need the dev deployment's `tiers` table, seeded from prod on 2026-10-19. A failed reply with "Subscription tiers are unavailable." means it is empty again. Report that to the user.
- Billing and checkout fail on dev, because the seeded tiers have no product IDs.
- This skill doesn't cover the desktop app, `bun run dev:desktop`, or the CLI, `sprocket run`.
