# Sprocket verification map

This directory holds the maintained recipes for Sprocket's user-facing web behavior, one file per feature. Update a file in the same change that alters the UI it describes.

## Baseline preconditions

- Launched, `doctor.sh` exits 0, and the browser shows `button "New thread"` on `$APP`, all as in `SKILL.md`.
- `$V/scratch-repo.sh` has created `/tmp/verify-sprocket-scratch`, and it is attached and selected as project `verify-sprocket-scratch`. Keep mutations inside it, since the user tests in the same dev account.
- Re-snapshot after every page change. Refs from another tab or from before a reload are stale.

## Proof and skip reporting

Proof follows Evidence in `SKILL.md`. Report an unreachable path as a failure with the command run and the unmet precondition, and record it in that feature's Gotchas. A journey passes only through the entry point it names.

## Features

- [Sign-in](./sign-in.md): the signed-out gate, host and browser device codes, persistence across restarts.
- [Projects](./projects.md): adding from the empty state and the project menu, switching projects, filtering the inbox by project.
- [Threads](./threads.md): sending a prompt, the model reply, stopping a run, renaming and settling, the transcript after reload.
- [Side panel](./side-panel.md): opening, the view picker, tabs, full workspace, closing and restoring.
- [Files](./files.md): the project tree, editing and saving a file, save conflicts, the discard prompt, creating, renaming and deleting, search.
- [tscircuit editor](./tscircuit.md): opening a circuit file in tscircuit, live reload of disk edits, the editor's writes.
- [Settings](./settings.md): the settings pages, a preference switch, the GitHub switch.
