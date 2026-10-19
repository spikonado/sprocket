# Side panel

The right side panel holds tabs. A new tab offers a view picker; artifacts and the agent's browser open as tabs.

## Sub-features

- `panel-open` opens and closes the panel.
- `panel-picker` turns a new tab into a view.
- `panel-tabs` adds and closes tabs.
- `panel-expand` toggles full workspace.

## How to get to it (user POV)

- Choose `button "Open side panel"` at the top right of the start screen or a thread.

## Driving it with agent-browser

- **Open.** Click `button "Open side panel"`. `snapshot -i` shows `separator "Resize side panel"`, `tab "New tab" [selected]`, `button "Close New tab tab"`, `button "New tab"`, `button "Expand to full workspace"`, `button "Close panel"`, and the picker's `button "Artifacts"` and `button "Browser"`.
- **Pick a view.** Click `button "Artifacts"`. The tab becomes `tab "Artifacts" [selected]` with `button "Close Artifacts tab"`, and the picker buttons are gone.
- **New tab.** Click `button "New tab"`. Another `tab "New tab"` with the picker appears.
- **Expand.** Click `button "Expand to full workspace"`. It becomes `button "Exit full workspace"`.
- **Close.** Click `button "Close panel"`. No `tab` remains in `snapshot -i`.

## Gotchas

- A picker button and the tab it creates share a name, such as `button "Artifacts"` and `tab "Artifacts"`. Grep the role too.
