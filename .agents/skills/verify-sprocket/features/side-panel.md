# Side panel

The right side panel holds tabs. A new tab offers a view picker for Artifacts, Files and Browser. The panel keeps its tabs per project when closed, until the page reloads.

## Sub-features

- `panel-open` opens and closes the panel.
- `panel-picker` turns a new tab into a view.
- `panel-tabs` adds and closes tabs. Closing the last tab closes the panel.
- `panel-expand` toggles full workspace.
- `panel-restore` brings back the tabs after a close and reopen.

## How to get to it (user POV)

- Choose `button "Open side panel"` at the top right of the start screen or a thread.
- Open an artifact from a thread. The panel opens on that artifact.

## Driving it with agent-browser

Precondition: the new-thread screen is open and the panel is closed.

- **Open.** Click `button "Open side panel"`. `snapshot -i` shows `separator "Resize side panel"`, `tab "New tab" [selected]`, `button "Close New tab tab"`, `button "New tab"`, `button "Expand to full workspace"`, `button "Close panel"`, and the picker's `button "Artifacts"`, `button "Files"` and `button "Browser"`.
- **Pick a view.** Click `button "Artifacts"`. The tab becomes `tab "Artifacts" [selected]` with `button "Close Artifacts tab"`, and the picker buttons are gone.
- **New tab.** Click `button "New tab"`. Another `tab "New tab" [selected]` with the picker appears.
- **Expand.** Click `button "Expand to full workspace"`. It becomes `button "Exit full workspace"` and the resize separator is gone. `agent-browser press Escape` restores both.
- **Close.** Click `button "Close panel"`. No `tab` remains in `snapshot -i`.
- **Restore.** Click `button "Open side panel"`. The same tabs return, with the last selected one still selected.
- **Last tab.** Close each tab with its `button "Close <name> tab"`. After the last one, the panel is gone and `button "Open side panel"` is back.

## Gotchas

- A picker button and the tab it creates share a name, such as `button "Artifacts"` and `tab "Artifacts"`. Grep the role too.
- `New tab` selects the existing empty tab instead of adding a second one. Pick a view first.
- The panel isn't rendered while Settings is open.
