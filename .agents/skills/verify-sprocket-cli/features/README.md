# Sprocket CLI verification map

This directory holds the maintained recipes for the `sprocket` CLI, one file per feature. Update a file in the same change that alters the command it describes.

## Baseline preconditions

- Launched and `doctor.sh` exits 0, as in `SKILL.md`. `C`, `SCRATCH`, `SIDE`, `OUT` and `VERIFY_CLI_OPENED` are set, and the shell is in `$SCRATCH`.
- The scaffold page exists: `mkdir -p $OUT/static && echo '<!doctype html><title>verify-sprocket-cli scaffold</title>' > $OUT/static/index.html`. It stands in for a built `apps/web/dist`, so `--web` and `serve` have a web app to serve.
- Keep mutations inside `/tmp/verify-sprocket-cli-scratch`, since the user tests in the same dev account.

## Proof and skip reporting

Proof follows Evidence in `SKILL.md`. Report an unreachable path as a failure with the command run and the unmet precondition, and record it in that feature's Gotchas. A journey passes only through the entry point it names.

## Features

- [Run](./run.md): a new thread, a follow-up, prompt files and stdin, model flags, listing models, timeout and interrupt, exit codes.
- [Login](./login.md): the signed-in check, the device-code login, logout, the credential store.
- [Serve](./serve.md): the API-only and full server, quiet output, the temporary server `run` spawns, port and profile conflicts.
- [App launch](./app-launch.md): bare `sprocket`, `sprocket <dir>`, `--web`, reopening a running server, argument conflicts.
- [Update](./update.md): `update --check` and the unsupported-install message.
