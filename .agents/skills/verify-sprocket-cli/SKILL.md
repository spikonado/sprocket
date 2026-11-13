---
name: verify-sprocket-cli
description: Verify the Sprocket `sprocket` CLI from the current worktree against the dev Convex deployment. Use to prove a change to `run`, `login`, `logout`, `serve`, `update`, `--web` or opening a directory, or to the CLI's local-server pairing.
---

# Verify the Sprocket CLI

Proof comes from the real binary built from this worktree, run against the dev Convex deployment, the way a user types it. Build Rust locally when verifying. That overrides the AGENTS.md rule against local Rust compilations.

## Helpers

Set `C=$(git rev-parse --show-toplevel)/.agents/skills/verify-sprocket-cli/scripts` and `W=$C/../../verify-sprocket/scripts` once, from inside the worktree.

| Command                                 | Does                                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `$C/build.sh`                           | Builds `sprocket-cli` into a path only this worktree uses and prints it.                                                   |
| `$C/cli.sh [NAME=value ...] <args>`     | Runs that binary like `sprocket <args>`, pinned to the dev profile. Waits for the shared lock when `<args>` need a server. |
| `$C/doctor.sh`                          | Health check. Exit 0 means worth driving.                                                                                  |
| `$C/record.sh <prefix> <cmd> [args...]` | Runs a command, saves its command line, stdout, stderr and exit code under `<prefix>`, then prints them.                   |
| `$C/stop.sh`                            | Kills processes running this worktree's CLI binary.                                                                        |
| `$W/scratch-repo.sh <dir>`              | The web skill's helper. Creates or reuses a remote-less git repo and prints its path.                                      |

## Machine facts

- A bare `sprocket` uses the user's installed app: its port, `~/.sprocket` and the prod deployment. `cli.sh` pins port 7731, `~/.sprocket-dev-verify` and the dev Convex URL. Run every CLI command through it.
- Agent shells inherit `SPROCKET_*` from the installed app, which point at the user's install: its update script, restart file, web bundle and git tokens. `cli.sh` drops all of them. Pass the ones a journey needs as leading `NAME=value` arguments, for example `$C/cli.sh SPROCKET_STATIC_DIR=$OUT/static --web`.
- The CLI shares port 7731 and `~/.sprocket-dev-verify` with the web skill, so one verify instance runs per machine. `cli.sh` takes the same `flock` as `../verify-sprocket/scripts/launch.sh`, and the lock lasts until `sprocket` and any server it spawned exit. "Lock held" means another agent is verifying: wait, and never stop it.
- Journeys that need a second server use the side profile, `SIDE="SPROCKET_PORT=7741 SPROCKET_DATA_DIR=/tmp/verify-sprocket-cli-profile"`, passed as `$C/cli.sh $SIDE ...`. It is signed out, and nobody else uses port 7741.
- Nothing may open on the user's machine. A debug-built bare `sprocket` with no desktop executable configured starts Electron from the worktree, and `--web` calls `xdg-open`. `cli.sh` points `SPROCKET_DESKTOP_EXECUTABLE` at the [`scripts/stubs`](scripts/stubs) `sprocket-desktop` and puts the stubs first on `PATH`, so both append their arguments to `$VERIFY_CLI_OPENED` instead.
- `../verify-sprocket/scripts/stop.sh` kills port listeners whose cwd is the worktree root, and other agents may share this worktree. Start `cli.sh` from the scratch repo.
- Model replies spend the user's dev quota. Use one-line prompts such as `Reply with exactly: pong`.

## Launch

1. `$C/build.sh`. A cold build takes about 15 minutes on this box, so give it a long timeout. Wait for any other agent editing `crates/` in this worktree to finish first.
2. `SCRATCH=$($W/scratch-repo.sh /tmp/verify-sprocket-cli-scratch)`.
3. Start `cd $SCRATCH && $C/cli.sh serve --api-only` as a background command session and keep its id. It prints `Lock held: ...` while another instance runs; poll every few minutes. Ready is `Sprocket API is running at http://127.0.0.1:7731`.

The `serve` session holds the lock for the whole drive, and later `cli.sh` calls share it. Without it, each command spawns a temporary server that exits once idle and drops the lock, so a queued agent can take the instance between two steps. Its output also logs each agent run.

To show a CLI run in the web UI, launch `../verify-sprocket` yourself, then prefix commands with `VERIFY_CLI_USE_WEB=1` so `cli.sh` attaches to that API instead of waiting for the lock it holds. Only for an instance you launched.

## Doctor

Run `$C/doctor.sh` after Launch, after any failed drive, and whenever anything looks off. Drive only after exit 0. A `not signed in` failure means follow [features/login.md](features/login.md).

## Drive

[features/README.md](features/README.md) indexes one recipe per feature. Read it before driving. Wrap each command in `$C/record.sh`.

## Evidence

Proof goes in `OUT=/tmp/verify-sprocket-cli/$(date +%Y%m%d-%H%M%S)-<feature>`, one per feature run, named after its feature file. `export VERIFY_CLI_OPENED=$OUT/opened.log` before driving.

- Stdout holds only the final answer; progress, headers and errors go to stderr. The exit code is part of the proof. The first `.err` lines come from `cli.sh` and its `nix develop` call, such as `warning: Git tree ... is dirty`.
- Every side effect gets a second view: `~/.sprocket-dev-verify/project-attachments.json`, the `serve` session output, the profile's `server-address.json`, `curl -s http://127.0.0.1:7731/api/health`, `opened.log`, a `run --thread` follow-up that recalls the first run, or the web UI through `../verify-sprocket`.
- Copy what you rely on from shared files and session output into `$OUT`, since the profile keeps changing and session logs aren't evidence.
- Drive only the user path: `sprocket` commands and their flags. Never call `/api/cli/*` with curl or Convex functions directly.

## Cleanup

Stop only what this run started.

1. Terminate the `serve` or `--web` command session, then run `$C/stop.sh` for any client or temporary server left behind.
2. In `$SCRATCH`, revert only the files this run changed with `git -C $SCRATCH checkout -- <paths>` and delete only the files it created. Other agents share it, so `checkout -- .` and `git clean` destroy their work. Keep the directory: `run` attached it as a project in the dev profile.
3. Keep `~/.sprocket-dev-verify`, `~/.cache/sprocket-verify-target` and the evidence in `/tmp/verify-sprocket-cli/`. Keep `/tmp/verify-sprocket-cli-profile` too, since its first server start downloads about 300 MB of agent tools.

Run cleanup after failed attempts too, so the next agent finds the lock and port free.

## Known limits

The desktop app itself belongs to `verify-sprocket-desktop`. Here the stubs only prove what the CLI launches.
