# Workspace launch

Running `sprocket <dir>` while the desktop app runs hands the directory to the open window, which comes to the front and opens that project in a new thread. A second launch of the app with `--sprocket-workspace=<dir>` does the same, since the app allows one instance per profile.

## Sub-features

- `launch-cli` opens a project from `sprocket <dir>`.
- `launch-second-instance` passes `--sprocket-workspace` from a second launch to the running window and quits.
- `launch-initial` opens the project when the app starts with `--sprocket-workspace`.

## How to get to it (user POV)

- Run `sprocket /path/to/repo` in a terminal.
- Open the app from a file manager or launcher entry that passes a folder.

## Driving it with agent-browser

Preconditions:

- Signed in, with `button "New thread"` in the window. Projects open only for a signed-in user.
- `$V/scratch-repo.sh` exists. Note the project list in the sidebar before the launch.
- `$D/electron.sh` stands in for the installed `sprocket-desktop`. It uses the same Electron profile as the running window, so a launch through it reaches the single-instance lock.

- **CLI.** `SPROCKET_DESKTOP_EXECUTABLE=$D/electron.sh ~/.cache/sprocket-verify-target/debug/sprocket /tmp/verify-sprocket-scratch`. It exits 0 at once. The window shows project `verify-sprocket-scratch` selected in a new thread.
- **Second instance.** `$D/electron.sh --sprocket-workspace=/tmp/verify-sprocket-scratch` exits within seconds, and the window opens the project as above.
- **Proof.** Screenshots before and after, plus `~/.sprocket-dev-verify/project-attachments.json` listing `/tmp/verify-sprocket-scratch`.

## Gotchas

- Unverified: no signed-in desktop window has been available yet.
- Without `SPROCKET_DESKTOP_EXECUTABLE`, a debug `sprocket` falls back to the `launch.cjs` of the worktree that last built the shared cache, without `--user-data-dir`. That starts a separate app instead of reaching the running one.
- Remove the project from the list afterwards, as in [`verify-sprocket`'s projects](../../verify-sprocket/features/projects.md).
