# Sprocket desktop verification map

This directory holds the maintained recipes for what the Electron shell adds to Sprocket, one file per feature. Web UI inside the window is mapped in [`verify-sprocket/features`](../../verify-sprocket/features/README.md); link there instead of repeating it. Update a file in the same change that alters the desktop behavior it describes.

## Baseline preconditions

- Launched, `$D/doctor.sh` exits 0, and `$D/connect.sh` printed `http://localhost:5173/`, all as in `SKILL.md`.
- Signed-in journeys also need `button "New thread"` in the window and `$V/scratch-repo.sh` attached as project `verify-sprocket-scratch`, as in `verify-sprocket`'s baseline.

## Proof and skip reporting

Proof follows Evidence in `SKILL.md`. Report an unreachable path as a failure with the command run and the unmet precondition, and record it in that feature's Gotchas. A journey passes only through the entry point it names.

## Features

- [Startup](./startup.md): Electron spawning the local server, attaching to a running one through the pairing proof, refusing a mismatched one, the server dying under the window.
- [Sign-in](./sign-in.md): the desktop gate, the AuthKit hand-off to the system browser, `Open browser`, cancel, completing and persisting a sign-in.
- [External links](./external-links.md): `https` links leaving for the system browser, other schemes refused, the window staying on the app origin.
- [Workspace launch](./workspace-launch.md): `sprocket <dir>` and a second app launch focusing the window and opening the project.
- [Unsaved changes](./unsaved-changes.md): the native `Leave Sprocket?` prompt when closing with an unsaved file.
- [Updates](./updates.md): the updater's disabled state in dev, and what only a packaged build reaches.
