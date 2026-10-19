---
name: verify-sprocket
description: Launch the real Sprocket web app (`bun dev`, Rust API + Vite + dev Convex) from the current worktree, sign in, drive it with agent-browser, and capture screenshots and side-effect proof. Use whenever a change to apps/web, apps/web/convex, or the Rust server needs to be shown working in the UI, or the user asks for screenshots, a live demo, or a tailscale URL.
---

# Verify Sprocket

Prove behavior on the real app: the Rust API from this worktree, Vite from this worktree, and the dev Convex deployment. Never build a mock page, a component harness, or a preview with fake data. The user rejects those. Compiling Rust locally is allowed for verification, even though AGENTS.md says not to run Rust checks.

Helpers live in `scripts/` next to this file. Set `V=$(git rev-parse --show-toplevel)/.agents/skills/verify-sprocket/scripts` and call them as `$V/<name>.sh`.

## Facts that shape every run

- One instance per machine. The API is fixed on `127.0.0.1:7731` and Vite on `localhost:5173` with `strictPort`. `launch.sh` refuses to start when either is taken. If another worktree's instance is running, ask the user before stopping it.
- Port `17731` is the installed Sprocket app, which may be the agent you are running in. Never stop it, drive it, or touch its tailscale serve mapping. Same for `4321`.
- `bun dev` runs `convex dev`. That pushes this worktree's `apps/web/convex` to the shared dev deployment and resets the dev AuthKit homepage URL to `http://localhost:5173`.
- `apps/web/.env.local` is gitignored and lives only in the main checkout. The helpers find it. It holds only `CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL`.
- The shell exports the prod `PUBLIC_CONVEX_URL`, and the committed root `.env` compiles prod in as a fallback. Every Sprocket process you start must get the dev URL. The helpers do this; anything you run by hand must too. A mixup signs the host into prod and registers this machine there.
- The dev AuthKit domain is `reassuring-poem-42-sprocket-previews.authkit.app`. If you ever see `crisp-glass-80.authkit.app`, that is prod: stop immediately.
- State shared by all worktrees, so sign-in and the cold build happen once per machine:
  - `~/.sprocket-dev-verify`: the server profile, holding host credentials and browser sessions (`sessions.json`).
  - agent-browser restore key `verify-sprocket-<hash>`: the browser cookie bound to that profile.
  - `~/.cache/sprocket-verify-target`: the cargo build cache.

## Launch

Start it as a background command session and keep the session id. Don't pipe its output through `grep` or `tail`: that buffers the log and hides the readiness lines.

```sh
$V/launch.sh
```

It builds `sprocket-cli` first. A cold build takes about 15 minutes on this 4-core box; incremental builds take seconds. Building first matters because `scripts/wait-for-api.mjs` gives the API only 120 s, and on timeout `concurrently -k` kills the whole stack. Don't build while another agent is editing `crates/` in the same worktree.

Ready means these lines appeared, then `doctor.sh` passes:

- `[api] Sprocket API is running at http://127.0.0.1:7731`
- `[web] ✔ ... Convex functions ready!`
- `[web]   ➜  Local:   http://localhost:5173/`

"Port 5173 is in use on a wildcard address, but localhost:5173 is available" is tailscale serve on the tailnet IP. Ignore it.

Web edits hot-reload. Rust edits need a restart: terminate the session, run `$V/stop.sh`, then `$V/launch.sh` again.

## Doctor

Run it first, and whenever anything looks off. It is read-only.

```sh
$V/doctor.sh
```

It checks `/api/health`, that `http://localhost:5173` returns 200, that the API process has the dev `PUBLIC_CONVEX_URL` (from `/proc/<pid>/environ`), and that the API and Vite run from this worktree. Any `FAIL` means don't drive it. A wrong Convex URL means stop it now.

## Sign in and open the app

Drive the tailnet URL, `https://<tailnet-host>:5173`. Don't drive `localhost`: its Sign In opens an AuthKit password page in the headless browser, and the agent must never handle the user's password. The tailnet origin uses device codes instead.

```sh
tailscale serve --bg --https=5173 http://localhost:5173
APP=https://$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'):5173
export AGENT_BROWSER_SESSION=$(agent-browser session id --scope worktree --prefix verify-sprocket)
export AGENT_BROWSER_RESTORE="$AGENT_BROWSER_SESSION"
agent-browser open "$APP"
agent-browser set viewport 1440 900
agent-browser snapshot -i
```

The serve mapping must target `http://localhost:5173`. Vite listens on `::1` only, so `127.0.0.1` gives 502, and `[::1]` gives 500. Leave the mapping in place afterwards; the stored sign-in depends on that origin. `AGENT_BROWSER_RESTORE` is the restore key itself, so `=1` would save under a key named `1`.

If the snapshot shows `button "New thread"`, you're signed in; skip the rest. If it shows `heading "Sign in to continue"`, sign in. There are two independent steps; do only the ones that fail.

1. Host. Click `Sign In`, then run plain `agent-browser snapshot`. An alert "The host is signed out. Run `sprocket login` on the host first." means the profile's host is signed out:
   1. Ask the user to be ready to approve a code within about 5 minutes. Start the login only once they say so.
   2. Start `$V/login.sh` as a background command. It prints `Open https://reassuring-poem-42-sprocket-previews.authkit.app/device in a browser and approve code XXXX-XXXX`. Check that the domain is the dev one.
   3. Send the user `https://reassuring-poem-42-sprocket-previews.authkit.app/device/?user_code=XXXX-XXXX`. The command prints `Signed in as <email>` and exits 0. On "Device login expired", go back to step 1.
2. Browser. Click `Sign In` again. A new tab opens on AuthKit, with `redirect_uri=...%2Fdevice%3Fuser_code%3DXXXX-XXXX`. Read the code from `agent-browser tab list` and ask the user to approve it the same way. Then `agent-browser tab close <that tab>`, `agent-browser tab t1`, and `agent-browser wait --text "New thread"`.

The agent can never approve a code itself. Once both steps are done, the session survives closing the browser and restarting the server.

## Drive

Keep both exports set for every call. After an hour idle the browser closes; the next command relaunches it and restores the cookie.

- Read with `snapshot -i` for refs. Use plain `snapshot` for alerts, banners and errors; `-i` hides them.
- Take refs from `snapshot -i | grep 'button "Files"'` with `grep -o 'ref=e[0-9]*' | cut -d= -f2`. `find role button --name X` is a substring match and can hit another control, such as `Attach files`.
- Some widgets render in a shadow root, for example `file-tree-container` from `@pierre/trees`. `find` and `click` can't see into it. Use the row's ref when `snapshot -i` lists it. Otherwise get coordinates with `eval --stdin` from `el.shadowRoot.querySelector(...)` and use `mouse move`, `mouse down` and `mouse up`.
- A hot reload after a source edit resets UI state such as the open side panel. Re-open it and re-query refs after every edit.
- `curl` can't reach `/api/*` without a bound browser session (`403 browser access requires loopback HTTP or same-origin HTTPS`, then `401`). For API checks, run `fetch` from the signed-in page with `agent-browser eval --stdin`, or use `agent-browser network requests --filter /api/`.
- `features/README.md` indexes the recipes. Read it before driving.

## Evidence

Put proof in `/tmp/verify-sprocket/<run-id>/`, for example `OUT=/tmp/verify-sprocket/$(date +%Y%m%d-%H%M%S)-<feature>`. Cleanup never deletes it.

- Before and after each user action, save `agent-browser screenshot $OUT/NN-step.png` and `agent-browser snapshot > $OUT/NN-step.txt`.
- Verify side effects in a second view, not only on screen. Check files on disk in the scratch repo and `~/.sprocket-dev-verify/project-attachments.json` for projects. Use `network requests --filter /api/` for API calls, and reopen threads after a reload.
- Drive the user path. Don't call internal setters, test-only routes, or Convex functions from the CLI to fake a state the UI should reach.
- Look at every screenshot with `parse_file` before you claim it shows something.
- To share images, convert them first; PNGs are about 1 MB each: `nix shell nixpkgs#libwebp -c cwebp -quiet -q 70 -resize 1400 0 in.png -o out.webp`. The box has no ImageMagick, PIL or ffmpeg. Embed the WebPs in one HTML artifact and keep its filename stable, because the artifact title follows the filename.
- When the user wants to try it, give them `$APP`. They sign in there with their own device code.

## Cleanup

Kill only what you started, never by process name.

1. `agent-browser close`. The restore state is saved on close.
2. Terminate the launch command session, then run `$V/stop.sh`. Terminating always leaves `vite dev` holding 5173, reparented to PID 1. `stop.sh` kills listeners on 5173 and 7731 that run from this worktree, leaves others alone, and exits non-zero if a port is still taken.
3. Keep the scratch repo `/tmp/verify-sprocket-scratch` and restore any files you changed in it (`git -C /tmp/verify-sprocket-scratch checkout -- . && git -C /tmp/verify-sprocket-scratch clean -fd`). The app has no way to remove a project, so deleting a project directory leaves a dangling project in the dev account. `scratch-repo.sh` recreates it at the same path after a reboot.
4. Keep `~/.sprocket-dev-verify`, the agent-browser restore state, the 5173 serve mapping, `~/.cache/sprocket-verify-target`, and `/tmp/verify-sprocket/`.

Run cleanup after failed attempts too, so the next launch finds free ports.

## Known limits

- Model replies depend on the dev deployment's `tiers` table, seeded from prod on 2026-10-19. If runs fail with 429 "Subscription tiers are unavailable", the table is empty again. Report it to the user instead of seeding it yourself.
- Billing and checkout don't work on dev: the seeded tiers have no product IDs.
- Desktop (`bun run dev:desktop`) and the CLI (`sprocket run`) are other entry points. This skill covers the web app.
