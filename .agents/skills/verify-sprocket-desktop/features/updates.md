# Updates

A packaged desktop app checks GitHub releases hourly. The sidebar then offers `Update available`, `Downloading… N%` and `Restart to update`, and a restart swaps in the new build. In dev the updater is disabled.

## Sub-features

- `updates-dev-off` reports `status: "unavailable"` with the current version in dev and makes no update request.
- `updates-flow` covers available, download, install and relaunch in a packaged build.

## How to get to it (user POV)

- Run an installed release when a newer one is published, and choose the sidebar's update button.

## Driving it with agent-browser

Preconditions:

- The app is open as in `SKILL.md`. Signed in for the sidebar check.

- **Dev off.** `agent-browser eval 'window.sprocketDesktopBridge.updates.getState()'` returns `method: "desktop"`, `status: "unavailable"` and `currentVersion` equal to `apps/desktop/package.json`'s `version`. When signed in, `snapshot -i` of the sidebar has none of the update labels. `agent-browser network requests --filter github` stays empty.
- **Proof.** The `eval` output and the sidebar snapshot.

## Gotchas

- `updates-flow` is unreachable here. It needs a packaged build (`app.isPackaged`), on Linux an AppImage with `APPIMAGE` set, and a newer published release. Report it as unreachable.
- The bridge call is a read of the state the sidebar renders, not a user action. The sidebar check is the user-facing half.
- The bridge call has been run. The sidebar and network checks need a signed-in window and have not.
