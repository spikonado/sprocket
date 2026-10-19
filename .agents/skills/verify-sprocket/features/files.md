# Files

The Files view in the side panel shows the selected project's tree. Opening a file adds an editor tab, and saving writes the file to disk.

## Sub-features

- `files-tree` lists the project's directories and files.
- `files-open` opens a file in its own editor tab.
- `files-save` writes edits to disk with Control+s.
- `files-discard` asks before closing a tab with unsaved edits.
- `files-search` filters the tree and opens the match with Enter.

## How to get to it (user POV)

- Open the side panel and choose `Files` in a new tab's view picker.

## Driving it with agent-browser

Precondition: the side panel shows `tab "Files" [selected]`, as in [side-panel.md](./side-panel.md).

- **Tree.** `snapshot -i` shows `button "New file"`, `button "New folder"`, `button "Refresh files"`, `textbox "Search files"`, and `treeitem "src"` and `treeitem "README.md"`.
- **Open.** Click `treeitem "README.md"`. `tab "README.md" [selected]` and `button "Close README.md tab"` appear, with a `textbox` holding `# Scratch`.
- **Edit.** Click the textbox, `agent-browser press Control+End`, then `agent-browser keyboard type "verified"`. The tab becomes `tab "README.md Unsaved changes"`.
- **Save.** `agent-browser press Control+s`. The tab is `tab "README.md"` again, and `/tmp/verify-sprocket-scratch/README.md` ends with `verified`.
- **Discard.** Type again and click `button "Close README.md tab"`. `dialog "Discard unsaved changes?"` offers `button "Cancel"` and `button "Discard and close"`. Discarding closes the tab and leaves the file on disk as last saved.
- **Search.** On `tab "Files"`, click `textbox "Search files"` and type `index`. `1 of 1`, `button "Clear search"` and `treeitem "index.ts"` show. `agent-browser press Enter` opens `tab "index.ts" [selected]`.

## Gotchas

- An edited tab's accessible name gains ` Unsaved changes`. Match on `tab "README.md` without the closing quote while it is dirty.
