# Update

`sprocket update` updates a global npm, bun, pnpm or yarn install on its release channel, and `--check` only reports whether a newer version exists. The npm launcher in `npm/sprocket` handles it before the native binary runs.

## Sub-features

- `update-check` reports up to date, available, or an unsupported install.
- `update-native` is the native binary's refusal when started without the launcher.
- `update-args` rejects unknown options.

## How to get to it (user POV)

- `sprocket update --check`, `sprocket upgrade --check`.
- `sprocket update`, which installs.

## Driving it with the npm launcher

Preconditions:

- Baseline preconditions hold. No server is needed.
- `L="nix develop $(git -C $C rev-parse --show-toplevel) -c node $(git -C $C rev-parse --show-toplevel)/npm/sprocket/bin/sprocket.js"`.

- **Check.** `$C/record.sh $OUT/01-check $L update --check`. From a worktree, exit 1 and stdout `This copy of Sprocket was not installed globally with npm, bun, pnpm, or yarn, so it cannot be updated in place.`
- **Unknown option.** `$C/record.sh $OUT/02-args $L update --bogus`. Exit 1, stderr `sprocket: Unknown option '--bogus'.` and ``Try `sprocket update --help`.``
- **Native.** `$C/record.sh $OUT/03-native $C/cli.sh update`. Exit 1, stderr `` `sprocket update` requires the usesprocket package launcher ``.

## Gotchas

- The up-to-date and available results need this checkout installed globally. No scratch global install is seeded, so report them as unreachable.
- `sprocket update` without `--check` installs into a global prefix. Never run it against the user's install, the `usesprocket` package under `~/.bun/install/global`.
- Running the user's installed `sprocket update --check` proves the released launcher, not this worktree.
