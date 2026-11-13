---
name: verify-sprocket-desktop
description: Verify Sprocket's Electron desktop app (`apps/desktop`) in a real dev window on an Xvfb display, driven with agent-browser over CDP against the dev Convex deployment. Use to prove a change to the desktop shell, its local-server startup, sign-in hand-off, external links, workspace launches or updater, or when the user asks for desktop screenshots.
---

# Verify Sprocket desktop

Proof comes from the real Electron app built from this worktree, the way `bun run dev:desktop` runs it, on a private Xvfb display. Web-only behavior belongs to `verify-sprocket`; this skill covers what the desktop shell adds. Build Rust locally when verifying, which overrides the AGENTS.md rule against local Rust compilations.

## Helpers

Set `D=$(git rev-parse --show-toplevel)/.agents/skills/verify-sprocket-desktop/scripts` and `V=$(git rev-parse --show-toplevel)/.agents/skills/verify-sprocket/scripts`. The sections below say when to run each `$D` script. `verify-sprocket`'s `$V/login.sh`, `$V/scratch-repo.sh` and `$V/ref.sh` work here too.

## Machine facts

Read Machine facts in [`verify-sprocket`](../verify-sprocket/SKILL.md) first. They hold here, except its agent-browser session and restore key, which Open the app replaces. Also:

- Start Electron only through `$D/launch.sh` or `$D/electron.sh`. `bun run dev:desktop` uses the repo-local `.sprocket-dev` data dir, `run-dev.mjs --desktop` without `--data-dir` uses the user's installed-app data in `~/.sprocket`, and the harness shell exports the installed app's `SPROCKET_*` variables and PostHog key. The helpers pass the verify profiles and clear those variables.
- Electron's profile `~/.sprocket-dev-verify-desktop` holds the window's session cookie and its single-instance lock, so a sign-in there persists, and a second launch on it hands off to the running window.
- External URLs never open a browser. The helpers put a recorder named `xdg-open` first on `PATH`, which appends each URL to `/tmp/verify-sprocket-desktop/opened-urls.log`.

## Launch

Start `$D/launch.sh` as a background command session and keep its id. Read its raw output, since a `grep` or `tail` pipe buffers it. When it prints `Ports in use`, keep it running and poll every few minutes. It launches once the other instance stops. A cold build takes about 15 minutes on this 4-core box, and the first launch also downloads the Electron binary.

Electron starts only after Vite answers on 5173, then spawns the server on 7731. Ready means `[electron] SPROCKET_LISTENING=http://127.0.0.1:7731` appeared and then `$D/doctor.sh` exits 0.

`[electron]` lines with `GLX is not present` or `dbus` errors are Xvfb noise. A `Failed to load Sprocket` box means the page never loaded; run Cleanup and launch again.

`[web] ✖ Schema validation failed` is the shared-deployment conflict described in `verify-sprocket`'s Launch. When this worktree leaves `apps/web/convex` untouched, launch with `SPROCKET_VERIFY_NO_PUSH=1 $D/launch.sh` instead, which runs Vite against the deployed functions without a push, and say so in the proof. Otherwise handle it as `verify-sprocket` does.

Web edits hot-reload in the window. For edits to `apps/desktop` or Rust, run Cleanup step 2 and launch again.

## Doctor

Run `$D/doctor.sh` before the first drive, after any failed drive, and whenever anything looks off. Drive only after exit 0. A `FAIL API ... is not Electron's` means the window attached to a server from somewhere else instead of spawning its own. The server inherits Electron's CDP socket, so two PIDs on 9393 are normal.

## Open the app

```sh
export AGENT_BROWSER_SESSION=verify-sprocket-desktop
unset AGENT_BROWSER_RESTORE
$D/connect.sh
agent-browser wait --text "New thread" --timeout 15000 || agent-browser wait --text "Sign in to continue"
agent-browser snapshot -i
```

- Export this session name in every command, since each command runs in a fresh shell. The thread's own session may be holding a normal browser, and a restore key would replay web cookies into Electron.
- `typeof window.sprocketDesktopBridge` in `eval` is `"object"` only inside Electron, which proves the page is the desktop renderer.
- `button "New thread"` means signed in. `heading "Sign in to continue"` means follow [features/sign-in.md](features/sign-in.md).
- The session stays attached until `agent-browser close`. After a relaunch, run `connect.sh` again.

## Drive

[features/README.md](features/README.md) indexes one recipe per desktop feature. Read it before driving. Signed-in web features run in the window with the recipes in [`verify-sprocket`'s map](../verify-sprocket/features/README.md), with this skill's Open the app in place of theirs.

- Snapshot, `$V/ref.sh`, context menus and `eval` work as in `verify-sprocket`'s Drive section.
- Native dialogs, such as error boxes and `Leave Sprocket?`, are GTK windows outside the page. `$D/screen.sh <out.png>` captures them. Drive them with xdotool after `source $D/common.sh` and `X="on_display nix shell nixpkgs#xdotool -c xdotool"`:
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
3. Reset scratch repos as in `verify-sprocket`'s Cleanup.
4. Keep `~/.sprocket-dev-verify`, `~/.sprocket-dev-verify-desktop`, `~/.cache/sprocket-verify-target` and the evidence in `/tmp/verify-sprocket-desktop/`, including `opened-urls.log`.

Run cleanup after failed attempts too, so the next launch finds free ports.

## Known limits

- The packaged app is out of reach: the static web dir, 17731, the AppImage updater and `sprocket-desktop` on `PATH` only exist in a release build. See [features/updates.md](features/updates.md).
- Completing a desktop sign-in needs the user. See [features/sign-in.md](features/sign-in.md).
- `main.mjs` prefers a system `xdg-open` from its `systemOpeners` list over `PATH`. On a box that has one, the recorder is bypassed and a real browser opens.
