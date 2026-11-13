# Workspace panels

The main workspace holds split panes of tabs. Each thread has one persistent Transcript tab with the conversation and composer. Layouts stay in memory per thread until reload.

## Driving it with agent-browser

Precondition: the new-thread screen or a thread is open, with the sidebar visible.

- **Transcript.** `snapshot -i` shows `tab "Transcript" [selected]` and the composer. There is no `Close Transcript tab` button. Focus the tab and press Delete; it stays open.
- **New tab.** Click `button "New tab"`. `tab "New tab" [selected]` offers `button "Artifacts"`, `button "Files"` and `button "Browser"`. Click Artifacts. The tab becomes `tab "Artifacts" [selected]` with `button "Close Artifacts tab"`. Select Transcript to return to the conversation and composer.
- **Split.** Click `button "Split right"`. A second `tablist` appears with a view picker and `separator "Resize panes side by side"`. Split down adds `separator "Resize stacked panes"`. Drag a separator, or focus it and press arrow keys, to resize. Close a pane's last tab to remove that pane and its separator. Closing other tabs leaves Transcript and its pane intact.
- **Thread restore.** In one existing scratch thread, open Files and split right, then resize the divider. Select a second scratch thread in the same project. It starts with only Transcript. Open Artifacts there. Return to the first thread and check its Files tab, split, active tabs and divider position. Return to the second thread and check Artifacts. Reload and confirm the layout resets to Transcript.
- **Browser.** In a new tab, click Browser. The view shows `status` `Browser ready`, `link "Open browser dashboard in a new tab"` and `Iframe "Agent browser dashboard"`. A cold start shows `Setting up the browser…` first. A failed setup shows an alert and Retry setup.
- **Phone.** Set viewport to `390 844`, close the inbox sidebar, and switch between Transcript and a new Artifacts tab. Both fit the main workspace. Restore `1440 900` afterwards.

## Gotchas

- Each pane has its own New tab and split buttons. Take refs from the intended pane.
- New tab focuses an existing empty tab in that pane rather than adding another.
- Splits require a minimum pane size. Widen the viewport or resize the pane if a split button is disabled.
- Opening an artifact or file uses the last focused pane.
- Settings replaces the workspace temporarily without discarding its layout.
