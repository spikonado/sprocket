# Serve

`sprocket serve` starts only the local server. With `--api-only` it serves the API for the Vite dev server; without it, it also serves a built web app. `run`, `login` and `logout` start a temporary server on their own when none is running.

## Sub-features

- `serve-api` starts the API only and names the dev web URL.
- `serve-quiet` prints machine-readable `SPROCKET_*` lines only.
- `serve-web` serves a static web app from `--static-dir` or `SPROCKET_STATIC_DIR`.
- `serve-temporary` is the server a CLI command spawns and the way it exits when idle.
- `serve-conflicts` reports a taken port, a profile owned by another server, and missing web files.

## Driving it with cli.sh

Preconditions:

- Baseline preconditions hold.
- Every journey but API only runs on the side profile, `$SIDE`, so the Launch session keeps the lock. Check `ss -Hltn '( sport = :7741 )'` prints nothing first.

- **API only.** The Launch session is this journey. Its output names the data directory `~/.sprocket-dev-verify`, the API at `http://127.0.0.1:7731` and the dev web URL. `curl -s http://127.0.0.1:7731/api/health > $OUT/01-health.json` returns status ok with that `httpBaseUrl` and the version.
- **Quiet.** Start `$C/cli.sh $SIDE serve --api-only --quiet` as a background session. Stdout is only `SPROCKET_*=` lines: the listening URL on port 7741, the side data directory and the dev web URL. Terminate it.
- **Static web app.** Start `$C/cli.sh $SIDE SPROCKET_STATIC_DIR=$OUT/static serve` as a background session. It prints `http://127.0.0.1:7741` as the URL to open. `curl -s http://127.0.0.1:7741/` returns the scaffold. Terminate it.
- **Temporary server.** `$C/record.sh $OUT/02-temp $C/cli.sh $SIDE run --list-models`. Exit 1 with `not signed in`, since the side profile is signed out. `cp /tmp/verify-sprocket-cli-profile/server-address.json $OUT/02-temp-server-address.json` holds `http://127.0.0.1:7741`, which proves a server started. `ss -Hltn '( sport = :7741 )'` printing nothing within 2 s proves it exited.
- **Conflicts.** Each exits 1:
  - `$C/cli.sh serve --api-only` while the Launch session runs: another server owns the data directory.
  - `$C/cli.sh $SIDE serve` with no `SPROCKET_STATIC_DIR`, from `/tmp`: web app files not found.

## Gotchas

- A second `cli.sh serve` shares the first one's lock, so the profile lock is what refuses it. That is the conflict under test.
- Without `--api-only`, the server also finds a built `apps/web/dist` above the cwd. Run from `/tmp` or the scratch repo so a stray build in the worktree doesn't mask the error.
- A temporary server that was never used exits after 30 s. One that served a client exits about a second after the last one leaves.
- A quiet temporary server sends only its stderr to `cli-server.log`. The log stays empty unless startup fails, so it is no proof that the server ran.
