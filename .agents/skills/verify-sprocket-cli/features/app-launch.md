# App launch

With no subcommand, `sprocket` opens the app. It launches the desktop app when one is installed, and otherwise starts a full server and opens the web app in the default browser. `sprocket <dir>` opens that directory as the workspace of a new thread. `--web` skips the desktop app, and when a server already runs, it opens the browser on that one instead of starting another.

## Sub-features

- `launch-desktop` runs `sprocket-desktop` and exits 0.
- `launch-directory` passes `--sprocket-workspace=<resolved dir>` to the desktop app, or `#workspace=<dir>` to the browser URL.
- `launch-web` starts a full server and opens `http://127.0.0.1:<port>`.
- `launch-reopen` opens the browser on a running server.
- `launch-conflicts` rejects `--web` with `serve`, a directory with a subcommand, and an API-only server.

## How to get to it (user POV)

- `sprocket`, `sprocket .`, `sprocket <dir>`.
- `sprocket --web`, `sprocket --web <dir>`.

## Driving it with cli.sh

Preconditions:

- Baseline preconditions hold, and `$C/doctor.sh` reports both stubs.
- Web and Reopen run on the side profile, `$SIDE`, while the Launch session keeps the lock.

- **Desktop.** `$C/record.sh $OUT/01-desktop $C/cli.sh`. Exit 0 at once with empty output. `opened.log` gains a `sprocket-desktop` line with no arguments.
- **Directory.** `$C/record.sh $OUT/02-dir $C/cli.sh .` from `$SCRATCH`. Exit 0. `opened.log` gains `sprocket-desktop --sprocket-workspace=/tmp/verify-sprocket-cli-scratch`. A path that doesn't exist exits 1 with `workspace does not exist: <path>`.
- **Web.** Start `$C/cli.sh $SIDE SPROCKET_STATIC_DIR=$OUT/static --web $SCRATCH` as a background session. It prints `Data directory: /tmp/verify-sprocket-cli-profile`, `Sprocket is running. Open in your browser:` and `http://127.0.0.1:7741/#workspace=%2Ftmp%2Fverify-sprocket-cli-scratch`. `opened.log` gains `xdg-open` with that URL. `curl -s http://127.0.0.1:7741/` returns the scaffold, and `/api/health` returns `"httpBaseUrl":"http://127.0.0.1:7741"`.
- **Reopen.** While Web runs, `$C/record.sh $OUT/03-reopen $C/cli.sh $SIDE SPROCKET_STATIC_DIR=$OUT/static --web`. Exit 0, stderr `Sprocket is already running. Opening it in your browser…`, and a second line `xdg-open http://127.0.0.1:7741`. Terminate the Web session.
- **Conflicts.** Each exits 1 with the quoted stderr:
  - `$C/cli.sh --web serve`: `` `--web` cannot be combined with `serve`; run `sprocket --web` ``.
  - `$C/cli.sh . serve`: ``a workspace directory cannot be combined with `serve` ``.
  - `$C/cli.sh --web` while the Launch `serve --api-only` session runs: `Sprocket is already running at http://127.0.0.1:7731 in API-only mode; stop it or set SPROCKET_PORT to launch the web app on a different port`.

## Gotchas

- The browser fallback, "The desktop app is not installed on this system, running Sprocket in the browser instead.", needs no `sprocket-desktop` on `PATH` and no `apps/desktop/launch.cjs` next to the build. With the stubs, a debug build never reaches it. Report `launch-desktop`'s fallback as unreachable here.
