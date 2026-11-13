# Startup

Opening the desktop app starts a local Sprocket server for the window, or joins one that already runs on the same data dir, and then loads the app. A server on the port with another data dir, or one that dies, ends in a native error box.

## Sub-features

- `startup-spawn` starts the server, checks it with a one-time bootstrap token, and loads the window.
- `startup-attach` joins a server already on 7731 when its pairing proof matches the data dir's `pairing-credential`.
- `startup-mismatch` refuses a server on 7731 that belongs to another data dir.
- `startup-server-exit` shows `Sprocket server stopped` and quits when the server dies under the window.
- `startup-renderer-timeout` shows `Failed to load Sprocket` when the window's page does not answer within 60 seconds.

## How to get to it (user POV)

- Open the desktop app with nothing on 7731.
- Open a second copy of the app, with its own profile, while the first one runs.
- Open the app while a different Sprocket profile's server holds 7731.

## Driving it with agent-browser and the Xvfb screen

Preconditions:

- Launched by `$D/launch.sh`, so the first window took the spawn path.
- Attach and mismatch start a second app with its own Electron profile, so the single-instance lock lets it run. Start it as a background command session and keep its id:

```sh
SPROCKET_VERIFY_ELECTRON_PROFILE=/tmp/verify-sprocket-desktop/second-profile SPROCKET_VERIFY_DATA_DIR=<data dir> \
	$D/electron.sh --remote-debugging-port=9394
```

- **Spawn.** Run `$D/doctor.sh > $OUT/doctor.txt`. The `API <pid> spawned by Electron with --data-dir ~/.sprocket-dev-verify` line and a dev `API Convex` line prove the window started its own server with the verify profile. `agent-browser screenshot $OUT/01-window.png` shows the app in the window, and `agent-browser eval 'typeof window.sprocketDesktopBridge'` returns `"object"`.
- **Attach.** Start the second app with `<data dir>` = `~/.sprocket-dev-verify`, then `curl -s localhost:9394/json/list` until it lists `http://localhost:5173/`. `ss -ltnp '( sport = :7731 )'` still shows the first server's PID, so no new server started. `AGENT_BROWSER_SESSION=verify-sprocket-desktop-second agent-browser connect 9394` and a screenshot show a second app window. Close that session, then terminate the command session.
- **Mismatch.** `mkdir -p /tmp/verify-sprocket-desktop/other-data`, then start the second app with that `<data dir>`. `$D/screen.sh $OUT/03-mismatch.png` shows the box "The Sprocket server at http://127.0.0.1:7731 uses a different data directory. Set SPROCKET_DATA_DIR to match it." Terminate the command session, then check that 7731 still serves the first window.
- **Server exit.** Kill the server PID from the doctor's API line. `$D/screen.sh $OUT/04-server-stopped.png` shows `Sprocket server stopped` with the server's exit reason, and the app quits once the box closes. Run Cleanup and launch again afterwards.
- **Renderer timeout.** Start the second app with `<data dir>` = `~/.sprocket-dev-verify` and `SPROCKET_ELECTRON_RENDERER_URL=http://localhost:5999` in front. After 60 seconds, `$D/screen.sh $OUT/05-renderer-timeout.png` shows `Failed to load Sprocket` with "ERR_CONNECTION_REFUSED (-102) loading ..." and an `Ok` button. Terminate the command session.

## Gotchas

- Attach, mismatch and server exit are drafted from `main.mjs` and have not been run yet. Fix this recipe on first use. The renderer timeout box has been seen once.
- A second Electron that shares `~/.sprocket-dev-verify-desktop` hands its arguments to the first window and quits. That is the workspace-launch path, not attach.
- The error boxes block Electron's quit until dismissed. Terminating the second app's command session is the cleanup. `$D/stop.sh` also stops any Electron left running from `apps/desktop`.
