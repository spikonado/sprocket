# App launch

With no subcommand, `sprocket` opens the app. It launches the desktop app when it finds one, and otherwise starts a full server and opens the web app in the default browser. `sprocket <dir>` opens that directory as the workspace of a new thread. `--web` skips the desktop app, and when a server already runs, it opens the browser on that one instead of starting another.

## Sub-features

- `launch-desktop` runs the desktop executable and exits 0.
- `launch-directory` passes `--sprocket-workspace=<resolved dir>` to the desktop app, or `#workspace=<dir>` to the browser URL.
- `launch-web` starts a full server and opens `http://127.0.0.1:<port>`.
- `launch-reopen` opens the browser on a running server.
- `launch-conflicts` rejects `--web` with `serve`, a directory with a subcommand, and an API-only server.

## Driving it with cli.sh

Preconditions:

- Baseline preconditions hold.
- Web and Reopen run on the side profile, `$SIDE`, while the Launch session keeps the lock.

- **Desktop.** `$C/record.sh $OUT/01-desktop $C/cli.sh`. Exit 0 at once with empty output. `opened.log` gains a `sprocket-desktop` line with no arguments.
- **Directory.** `$C/record.sh $OUT/02-dir $C/cli.sh .` from `$SCRATCH`. Exit 0. `opened.log` gains `sprocket-desktop --sprocket-workspace=/tmp/verify-sprocket-cli-scratch`. A path that doesn't exist exits 1 because the workspace does not exist.
- **Web.** Start `$C/cli.sh $SIDE SPROCKET_STATIC_DIR=$OUT/static --web $SCRATCH` as a background session. It prints the side data directory and `http://127.0.0.1:7741/#workspace=` with the encoded scratch path. `opened.log` gains `xdg-open` with that URL. `curl -s http://127.0.0.1:7741/` returns the scaffold, and `/api/health` returns `"httpBaseUrl":"http://127.0.0.1:7741"`.
- **Reopen.** While Web runs, `$C/record.sh $OUT/03-reopen $C/cli.sh $SIDE SPROCKET_STATIC_DIR=$OUT/static --web`. Exit 0, stderr says Sprocket is already running, and `opened.log` gains `xdg-open http://127.0.0.1:7741`. Terminate the Web session.
- **Conflicts.** Each exits 1:
  - `$C/cli.sh --web serve` points to `sprocket --web`.
  - `$C/cli.sh . serve` rejects the workspace directory.
  - `$C/cli.sh --web` while the Launch `serve --api-only` session runs reports the API-only server on 7731 and suggests another `SPROCKET_PORT`.

## Gotchas

- The browser fallback needs a release build with no desktop executable set or recorded in the profile. `cli.sh` always sets one, and clearing it makes a debug build start Electron from the worktree. Report the fallback as unreachable here.
