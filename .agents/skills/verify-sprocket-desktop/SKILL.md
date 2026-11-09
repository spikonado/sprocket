---
name: verify-sprocket-desktop
description: Verify Sprocket's Electron desktop app (`apps/desktop`) in a real dev window on an Xvfb display, driven with agent-browser over CDP against the dev Convex deployment. Use to prove a change to the desktop shell, its local-server startup, sign-in hand-off, external links, workspace launches or updater, or when the user asks for desktop screenshots.
---

# Verify Sprocket desktop

Proof comes from the real Electron app built from this worktree, the way `bun run dev:desktop` runs it, on a private Xvfb display. Web-only behavior belongs to `verify-sprocket`; this skill covers what the desktop shell adds. Build Rust locally when verifying, which overrides the AGENTS.md rule against local Rust compilations.

## Helpers

Set `D=$(git rev-parse --show-toplevel)/.agents/skills/verify-sprocket-desktop/scripts` once.

| Command                  | Does                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `$D/launch.sh`           | Takes the verify lock, starts Xvfb with openbox, installs bun deps, builds `sprocket-cli`, then runs Vite and Electron in the foreground. |
| `$D/doctor.sh`           | Read-only health check of Xvfb, Electron's CDP port, the window's page, the server Electron spawned and Vite. Exit 0 means worth driving. |
| `$D/connect.sh`          | Attaches the current agent-browser session to Electron and selects the app page. Prints its URL.                                          |
| `$D/electron.sh [args]`  | Starts an app on the instance's display with the verify env. `launch.sh` starts the main window through it.                               |
| `$D/screen.sh <out.png>` | Captures the whole Xvfb screen, including native dialogs that a CDP screenshot misses.                                                    |
| `$D/stop.sh`             | Stops this worktree's Electron, the server it spawned, the leftover Vite, openbox and Xvfb, then removes the `target/` symlink.           |

`verify-sprocket`'s helpers still apply: `$V/login.sh` for the host, `$V/scratch-repo.sh` for projects, `$V/ref.sh` for refs, with `V=$(git rev-parse --show-toplevel)/.agents/skills/verify-sprocket/scripts`.

## Machine facts

Read Machine facts in [`verify-sprocket`](../verify-sprocket/SKILL.md) first. They hold here, except its agent-browser session and restore key, which Open the app replaces. On top of that:

- `bun run dev:desktop` uses the repo-local `.sprocket-dev` data dir, and `run-dev.mjs --desktop` without `--data-dir` uses `~/.sprocket`, the user's installed-app data. The harness shell also exports the installed app's `SPROCKET_*` variables and PostHog key. Start Electron only through `$D/launch.sh` or `$D/electron.sh`, which pass the verify profile and clear those variables.
- `launch.cjs` picks Wayland when `WAYLAND_DISPLAY` is set or `$XDG_RUNTIME_DIR/wayland-0` exists. `launch.sh` forces X11 on its own Xvfb display and runs openbox on it. Without a window manager, close requests never reach Electron and windows render blank in screen captures. Commands against that display go through `on_display` in `scripts/common.sh`.
- Electron's profile is `~/.sprocket-dev-verify-desktop`, passed as `--user-data-dir`. It holds the window's session cookie and its single-instance lock, so a sign-in there persists.
- Electron opens external URLs with `xdg-open`. `launch.sh` puts `scripts/bin/xdg-open` first on `PATH`, which appends each URL with a timestamp to `/tmp/verify-sprocket-desktop/opened-urls.log` instead of opening a browser.
- In dev, `main.mjs` runs the server from `<worktree>/target/debug/sprocket`. `launch.sh` builds with `../verify-sprocket-cli/scripts/build.sh`, symlinks that path to this worktree's copy of the build, and `stop.sh` removes the symlink.
- CDP listens on `127.0.0.1:9393`. Set `SPROCKET_VERIFY_CDP_PORT` for every helper when that port is taken.

## Launch

Start `$D/launch.sh` as a background command session and keep its id. Read its raw output, since a `grep` or `tail` pipe buffers it. When it prints `Ports in use`, keep it running and poll every few minutes; it launches once the other instance stops. A cold build takes about 15 minutes on this 4-core box, and the first launch also downloads the Electron binary.

Electron starts once Vite answers on 5173, then spawns the server on 7731. Ready means these lines appeared and then `$D/doctor.sh` exits 0:

- `Xvfb <pid> with openbox <pid> on :<n>`
- `[web]   ➜  Local:   http://localhost:5173/`
- `[electron] DevTools listening on ws://127.0.0.1:9393/...`
- `[electron] SPROCKET_LISTENING=http://127.0.0.1:7731`
- `[electron] SPROCKET_DATA_DIR=.../.sprocket-dev-verify`

`[electron]` lines with `GLX is not present` or `dbus` errors are Xvfb noise. A `Failed to load Sprocket` box means the page never loaded; run Cleanup and launch again.

`[web] ✖ Schema validation failed` is the shared-deployment conflict described in `verify-sprocket`'s Launch. When this worktree leaves `apps/web/convex` untouched, launch with `SPROCKET_VERIFY_NO_PUSH=1 $D/launch.sh` instead, which runs `bun run --cwd apps/web vite dev` against the deployed functions without a push, and say so in the proof. Otherwise handle it as `verify-sprocket` does.

Web edits hot-reload in the window. For edits to `apps/desktop` or Rust, run Cleanup step 2 and launch again.

## Doctor

Run `$D/doctor.sh` before the first drive, after any failed drive, and whenever anything looks off. Drive only after exit 0. A `FAIL API ... is not Electron's` means the server on 7731 came from somewhere else, so the window attached to it instead of spawning its own.

## Open the app

```sh
export AGENT_BROWSER_SESSION=verify-sprocket-desktop
unset AGENT_BROWSER_RESTORE
$D/connect.sh
agent-browser wait --text "New thread" --timeout 15000 || agent-browser wait --text "Sign in to continue"
agent-browser snapshot -i
```

- Use this session name for every call. The thread's own session may be holding a normal browser, and a restore key would replay web cookies into Electron.
- `connect.sh` and `agent-browser tab list` skip the detached DevTools window, so the selected tab is the app page.
- `typeof window.sprocketDesktopBridge` in `eval` is `"object"` only inside Electron, which proves the page is the desktop renderer.
- `button "New thread"` means signed in. `heading "Sign in to continue"` means follow [features/sign-in.md](features/sign-in.md).
- After `connect.sh`, the session stays attached until `agent-browser close`. After a relaunch, run `connect.sh` again.

## Drive

[features/README.md](features/README.md) indexes one recipe per desktop feature. Read it before driving. Signed-in web features run in the window with the recipes in [`verify-sprocket`'s map](../verify-sprocket/features/README.md), with this skill's Open the app in place of theirs.

- Snapshot, `$V/ref.sh`, context menus and `eval` work as in `verify-sprocket`'s Drive section.
- Native dialogs (error boxes, `Leave Sprocket?`) are GTK windows outside the page. `$D/screen.sh` captures them. Drive them with xdotool after `source $D/common.sh` and `X="on_display nix shell nixpkgs#xdotool -c xdotool"`:
  - `$X search --name '<title>'` finds a window, `$X getwindowgeometry <id>` gives its position and size, and `$X mousemove <x> <y> click 1` presses a button inside it.
  - `$X key Escape` and `$X key Return` do not reach the GTK dialogs. Click the buttons instead.
  - `$X search --name Sprocket windowquit` closes a window the way a user does. `windowclose` destroys it without Electron's `close` event, and `windowkill` kills the client.

## Evidence

Proof goes in `OUT=/tmp/verify-sprocket-desktop/$(date +%Y%m%d-%H%M%S)-<feature>`, one per feature run, named after its feature file. `verify-sprocket`'s Evidence section applies in full, including screenshots, snapshots and WebP sharing. Desktop additions:

- Use `$D/screen.sh $OUT/NN-step-screen.png` when a native window is involved.
- Copy `$D/doctor.sh` output into `$OUT/doctor.txt`, since it records which process spawned the server and with which data dir.
- For anything that opens a browser, copy the new lines of `/tmp/verify-sprocket-desktop/opened-urls.log` into `$OUT`.

## Cleanup

Stop only what this run started, by PID.

1. `agent-browser close`. For a CDP-attached session this disconnects and leaves Electron running.
2. Terminate the launch command session, then run `$D/stop.sh`. It exits 1 when a process it should have stopped remains.
3. Reset scratch repos as in `verify-sprocket`'s Cleanup step 3.
4. Keep `~/.sprocket-dev-verify`, `~/.sprocket-dev-verify-desktop`, `~/.cache/sprocket-verify-target` and the evidence in `/tmp/verify-sprocket-desktop/`, including `opened-urls.log`.

Run cleanup after failed attempts too, so the next launch finds free ports.

## Known limits

- The packaged app is out of reach: the static web dir, 17731, the AppImage updater and `sprocket-desktop` on `PATH` only exist in a release build. See [features/updates.md](features/updates.md).
- Completing a desktop sign-in needs the user. See [features/sign-in.md](features/sign-in.md).
- `main.mjs` prefers `/run/current-system/sw/bin/xdg-open`, `/usr/bin/xdg-open` and `/usr/local/bin/xdg-open` over `PATH`. On a box that has one, the recorder is bypassed and a real browser opens.
- The server Electron spawns inherits Electron's CDP listening socket, so `ss` shows both PIDs on 9393.
