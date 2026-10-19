---
name: verify-sprocket
description: Verify Sprocket web app changes in the real running app (Rust API, Vite and the dev Convex deployment from the current worktree), driven with agent-browser. Use to prove a UI, Convex, or server change works, or when the user asks for screenshots, a live demo, or a tailnet URL.
---

# Verify Sprocket

Proof comes from the real app: the Rust API and Vite from this worktree, against the dev Convex deployment, driven the way a user drives it. Mock pages and fake-data previews are not proof; the user rejects them. Local Rust builds are allowed for verification, overriding AGENTS.md.

## Helpers

Set `V=$(git rev-parse --show-toplevel)/.agents/skills/verify-sprocket/scripts` once.

| Command                    | Does                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `$V/launch.sh`             | Builds `sprocket-cli`, then runs `bun dev` in the foreground. Refuses when 5173 or 7731 is taken.     |
| `$V/doctor.sh`             | Read-only health check. Exit 0 means the instance is worth driving.                                   |
| `$V/login.sh`              | Signs the profile's host in with a device code.                                                       |
| `$V/stop.sh`               | Kills this worktree's leftover dev-port listeners.                                                    |
| `$V/scratch-repo.sh [dir]` | Creates or reuses a remote-less git repo and prints its path. Default `/tmp/verify-sprocket-scratch`. |

## Machine facts

- One instance per machine. The API is fixed on `127.0.0.1:7731` and Vite on `localhost:5173` with `strictPort`. When another worktree's instance holds them, ask the user before stopping it.
- Ports `17731` (the installed Sprocket app, possibly the agent you run in) and `4321` belong to the user. Leave them and their tailscale serve mappings alone.
- `bun dev` runs `convex dev`. That pushes this worktree's `apps/web/convex` to the shared dev deployment and sets the dev AuthKit homepage URL to `http://localhost:5173`.
- `apps/web/.env.local` is gitignored and lives only in the main checkout. It holds `CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL`.
- The shell exports the prod `PUBLIC_CONVEX_URL`, and the committed root `.env` compiles prod in as a fallback. Every Sprocket process needs the dev URL; the helpers pass it, and anything run by hand must too. A mixup signs the host into prod and registers this machine there.
- Shared across worktrees, so sign-in and the cold build happen once per machine:
  - `~/.sprocket-dev-verify`: the server profile, with host credentials and browser sessions.
  - agent-browser session and restore key `verify-sprocket`: the browser cookie bound to that profile.
  - `~/.cache/sprocket-verify-target`: the cargo build cache.

## Launch

Start `$V/launch.sh` as a background command session and keep its id. Read its raw output; a `grep` or `tail` pipe buffers it.

A cold build takes about 15 minutes on this 4-core box, incremental builds seconds. Wait for any other agent editing `crates/` in this worktree to finish first.

Ready means these lines appeared and then `$V/doctor.sh` exits 0:

- `[api] Sprocket API is running at http://127.0.0.1:7731`
- `[web] ✔ ... Convex functions ready!`
- `[web]   ➜  Local:   http://localhost:5173/`

Vite's "Port 5173 is in use on a wildcard address" is tailscale serve on the tailnet IP and is harmless.

Web edits hot-reload. For Rust edits, run Cleanup step 2 and launch again.

## Doctor

Run `$V/doctor.sh` first and whenever anything looks off. Drive only after exit 0. A FAIL on the API's Convex URL means stop the instance now.

## Open the app

Drive the tailnet origin. It signs in with device codes the user approves on their own device; the `localhost` origin would need the user's AuthKit password typed into the headless browser.

```sh
tailscale serve --bg --https=5173 http://localhost:5173
APP=https://$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'):5173
export AGENT_BROWSER_SESSION=verify-sprocket AGENT_BROWSER_RESTORE=verify-sprocket
agent-browser open "$APP"
agent-browser set viewport 1440 900
agent-browser snapshot -i
```

- The mapping targets `http://localhost:5173` because Vite listens on `::1` only (`127.0.0.1` gives 502, `[::1]` gives 500). It stays in place, since the stored sign-in belongs to that origin.
- `AGENT_BROWSER_RESTORE` is the restore key itself. Keep both exports for every call: after an hour idle the browser closes, and the next command relaunches it with the cookie restored.
- `button "New thread"` in the snapshot means signed in. `heading "Sign in to continue"` means follow [features/sign-in.md](features/sign-in.md) first.

## Drive

[features/README.md](features/README.md) indexes one recipe per feature. Read it before driving.

- `snapshot -i` gives refs. Plain `snapshot` also shows alerts, banners and errors.
- Take a ref from its exact accessible name: `snapshot -i | grep 'button "Files"' | grep -o 'ref=e[0-9]*' | cut -d= -f2`. `find role button --name X` matches substrings and can hit `Attach files`.
- Shadow-root widgets such as `file-tree-container` from `@pierre/trees` are invisible to `find` and `click`. Use the row's ref when `snapshot -i` lists it, or coordinates from `eval --stdin` on `el.shadowRoot.querySelector(...)` with `mouse move`, `mouse down` and `mouse up`.
- A hot reload resets UI state such as the open side panel. Re-open it and re-take refs after each source edit.
- API checks go through the signed-in page: `fetch` in `agent-browser eval --stdin`, or `agent-browser network requests --filter /api/`. Plain `curl` to `/api/*` gets 403 or 401.

## Evidence

Proof goes in `OUT=/tmp/verify-sprocket/$(date +%Y%m%d-%H%M%S)-<feature>`, one per feature run, named after its feature file. It outlives cleanup.

- Before and after each user action: `agent-browser screenshot $OUT/NN-step.png` and `agent-browser snapshot > $OUT/NN-step.txt`.
- Every mutation gets a second view besides the screen: files in the scratch repo, `~/.sprocket-dev-verify/project-attachments.json`, network requests, the launch log, or the page after a reload.
- The user path only: UI actions, not internal setters, test-only routes, or Convex functions called from the CLI.
- Open each screenshot with `parse_file` before describing it.
- Shared images go out as WebP, since PNGs are about 1 MB: `nix shell nixpkgs#libwebp -c cwebp -quiet -q 70 -resize 1400 0 in.png -o out.webp`. The box has no ImageMagick, PIL or ffmpeg. Embed them in one HTML artifact with a stable filename; the artifact title follows the filename.
- A user who wants to try it gets `$APP` and signs in there with their own device code.

## Cleanup

Stop only what this run started, by PID.

1. `agent-browser close`, which saves the restore state.
2. Terminate the launch command session, then run `$V/stop.sh`. Terminating always leaves `vite dev` on 5173 under PID 1. `stop.sh` exits non-zero if a dev port is still taken.
3. Reset the scratch repo: `git -C /tmp/verify-sprocket-scratch checkout -- . && git -C /tmp/verify-sprocket-scratch clean -fd`. Keep the directory: projects can't be removed in the app, so a deleted directory leaves a dangling project in the dev account.
4. Keep `~/.sprocket-dev-verify`, the `verify-sprocket` restore state, the 5173 serve mapping, `~/.cache/sprocket-verify-target` and `/tmp/verify-sprocket/`.

Run cleanup after failed attempts too, so the next launch finds free ports.

## Known limits

- Model replies need the dev deployment's `tiers` table, seeded from prod on 2026-10-19. A 429 "Subscription tiers are unavailable" means it is empty again; report that to the user.
- Billing and checkout fail on dev: the seeded tiers have no product IDs.
- Desktop (`bun run dev:desktop`) and the CLI (`sprocket run`) are separate entry points this skill doesn't cover.
