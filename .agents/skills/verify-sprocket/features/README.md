# Sprocket verification map

The maintained recipes for Sprocket's user-facing web behavior, one file per feature. Update a file in the same change that alters the UI it describes.

## Baseline preconditions

- Launched, `doctor.sh` exits 0, and the browser shows `button "New thread"` on `$APP`, all as in `SKILL.md`.
- `/tmp/verify-sprocket-scratch` exists (`$V/scratch-repo.sh`) and is attached and selected as project `verify-sprocket-scratch`. Mutations stay inside it, since the dev account is shared with the user's own testing.
- Re-snapshot after every page change; refs from another tab or before a reload are stale.

## Proof and skip reporting

Proof follows Evidence in `SKILL.md`. An unreachable path is reported as a failure with the command run and the unmet precondition, and recorded in that feature's Gotchas. A journey passes only through the entry point it names.

## Features

- [Sign-in](./sign-in.md): the signed-out gate, host and browser device codes, persistence across restarts.
- [Projects](./projects.md): adding from the empty state and the project menu, switching projects.
- [Threads](./threads.md): sending a prompt, the model reply, the inbox entry, the transcript after reload.
- [Side panel](./side-panel.md): opening, the view picker, tabs, full workspace, closing.
