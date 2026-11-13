# Workspace panels

The main workspace holds split panes of tabs when a thread is selected. Each thread has one persistent Thread tab with the conversation and composer. Layouts stay in memory per thread until reload.

## Driving it with agent-browser

Precondition: an existing scratch thread is open, with the sidebar visible.

- **Thread tab.** `snapshot -i` shows `tab "Thread" [selected]` and the composer. There is no `Close Thread tab` button. Focus the tab and press Delete; it stays open.
- **New tab.** Click `button "New tab"`. `tab "New tab" [selected]` offers `button "Artifacts"`, `button "Files"` and `button "Browser"`. Click Artifacts. The tab becomes `tab "Artifacts" [selected]` with `button "Close Artifacts tab"`. Select Thread to return to the conversation and composer.
- **Split.** Click `button "Split right"`. A second `tablist` appears with a view picker and `separator "Resize panes side by side"`. Split down adds `separator "Resize stacked panes"`. Drag a separator, or focus it and press arrow keys, to resize. Close a pane's last tab to remove that pane and its separator. Closing other tabs leaves Thread and its pane intact.
- **Thread restore.** In one existing scratch thread, open Files and split right, then resize the divider. Select a second scratch thread in the same project. It starts with only Thread. Open Artifacts there. Return to the first thread and check its Files tab, split, active tabs and divider position. Return to the second thread and check Artifacts. Reload and confirm the layout resets to Thread.
- **New thread screen.** Click `button "New thread"`. The heading and composer appear without a tablist, New tab button, or split controls. Return to the scratch thread and confirm its panels restore.
- **Browser.** In a new tab, click Browser. The view shows `status` `Browser ready`, `link "Open browser dashboard in a new tab"` and `Iframe "Agent browser dashboard"`. A cold start shows `Setting up the browser…` first. A failed setup shows an alert and Retry setup.
- **Phone.** Set viewport to `390 844`, close the inbox sidebar, and switch between Thread and a new Artifacts tab. Both fit the main workspace. Restore `1440 900` afterwards.

## Gotchas

- Each pane has its own New tab and split buttons. Take refs from the intended pane.
- New tab focuses an existing empty tab in that pane rather than adding another.
- Splits require a minimum pane size. Widen the viewport or resize the pane if a split button is disabled.
- Opening an artifact or file uses the last focused pane.
- Settings replaces the workspace temporarily without discarding its layout.
