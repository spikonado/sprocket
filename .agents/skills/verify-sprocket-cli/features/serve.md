# Serve

`sprocket serve` starts only the local server. With `--api-only` it serves the API for the Vite dev server; without it, it also serves a built web app. `run`, `login` and `logout` start a temporary server on their own when none is running.

## Sub-features

- `serve-api` starts the API only and names the dev web URL.
- `serve-quiet` prints machine-readable `SPROCKET_*` lines only.
- `serve-web` serves a static web app from `--static-dir` or `SPROCKET_STATIC_DIR`.
- `serve-temporary` is the server a CLI command spawns and the way it exits when idle.
- `serve-conflicts` reports a taken port, a profile owned by another server, and missing web files.

## How to get to it (user POV)

- `sprocket serve --api-only`, `sprocket serve`, `sprocket serve --quiet`.
- Any `sprocket run` with no server running.

## Driving it with cli.sh

Preconditions:

- Baseline preconditions hold.
- Every journey but API only runs on the side profile, `$SIDE`, so the Launch session keeps the lock. Check `ss -Hltn '( sport = :7741 )'` prints nothing first.

- **API only.** The Launch session is this journey. Its output has `Data directory: /home/amronos/.sprocket-dev-verify`, `Sprocket API is running at http://127.0.0.1:7731`, then the dev web URL `http://localhost:5173`. `curl -s http://127.0.0.1:7731/api/health > $OUT/01-health.json` returns `{"status":"ok","httpBaseUrl":"http://127.0.0.1:7731","version":"<version>"}`.
- **Quiet.** Start `$C/cli.sh $SIDE serve --api-only --quiet` as a background session. Stdout is exactly `SPROCKET_LISTENING=http://127.0.0.1:7741`, `SPROCKET_DATA_DIR=/tmp/verify-sprocket-cli-profile` and `SPROCKET_DEV_WEB_URL=http://localhost:5173`. Terminate it.
- **Static web app.** Start `$C/cli.sh $SIDE SPROCKET_STATIC_DIR=$OUT/static serve` as a background session. It prints `Sprocket is running. Open in your browser:` and `http://127.0.0.1:7741`. `curl -s http://127.0.0.1:7741/` returns the scaffold. Terminate it.
- **Temporary server.** `$C/record.sh $OUT/02-temp $C/cli.sh $SIDE run --list-models`. Exit 1 with `not signed in; run sprocket login`, since the side profile is signed out. `cp /tmp/verify-sprocket-cli-profile/server-address.json $OUT/02-temp-server-address.json` holds `{"url":"http://127.0.0.1:7741"}`, which proves a server started. `ss -Hltn '( sport = :7741 )'` printing nothing within 2 s proves it exited.
- **Conflicts.** Each exits 1 with the quoted stderr:
  - `$C/cli.sh serve --api-only` while the Launch session runs: `another Sprocket server owns this data directory; connect to it or use a different SPROCKET_DATA_DIR`.
  - `$C/cli.sh $SIDE serve` with no `SPROCKET_STATIC_DIR`, from `/tmp`: `Web app files not found. Build them with ...`.

## Gotchas

- A second `cli.sh serve` shares the first one's lock, so the profile lock is what refuses it. That is the conflict under test.
- Without `--api-only`, the server looks for `apps/web/dist` in the cwd and up to four parents, then next to the binary. Run from the scratch repo so a stray build in the worktree doesn't mask the error.
- A temporary server that was never used exits after 30 s. One that served a client exits about a second after the last one leaves.
- A quiet temporary server sends only its stderr to `cli-server.log`. The log stays empty unless startup fails, so it is no proof that the server ran.
- `PUBLIC_POSTHOG_KEY` is blank under `cli.sh`, so no analytics leave the box.
