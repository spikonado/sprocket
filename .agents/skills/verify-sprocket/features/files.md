# Files

The Files view in the side panel shows the selected project's tree. Opening a file adds an editor tab, and saving writes the file to disk. The tree also creates, renames and deletes files.

## Sub-features

- `files-tree` lists the project's directories and files.
- `files-open` opens a file in its own editor tab.
- `files-save` writes edits to disk with Control+s.
- `files-conflict` offers Reload and Overwrite when the file changed on disk during an edit.
- `files-discard` asks before closing a tab with unsaved edits.
- `files-create` adds a file from the toolbar and opens it.
- `files-menu` renames and deletes from a row's context menu, and open tabs follow.
- `files-search` filters the tree and opens the match with Enter.

## How to get to it (user POV)

- Open the side panel and choose `Files` in a new tab's view picker.

## Driving it with agent-browser

Precondition: the side panel shows `tab "Files" [selected]`, as in [side-panel.md](./side-panel.md).

- **Tree.** `snapshot -i` shows `button "New file"`, `button "New folder"`, `button "Refresh files"`, `textbox "Search files"`, and `treeitem "src"` and `treeitem "README.md"`.
- **Open.** Click `treeitem "README.md"`. `tab "README.md" [selected]` and `button "Close README.md tab"` appear, with a `textbox` holding `# Scratch`.
- **Edit.** Click the textbox, `agent-browser press Control+End`, then `agent-browser keyboard type "verified"`. The tab becomes `tab "README.md Unsaved changes"`.
- **Save.** `agent-browser press Control+s`. The tab is `tab "README.md"` again, and `/tmp/verify-sprocket-scratch/README.md` ends with `verified`.
- **Conflict.** Type ` again`, then run `echo external >> /tmp/verify-sprocket-scratch/README.md`. Within about 5 s, plain `snapshot` shows an `alert` "This file changed on disk while you were editing." with `button "Reload"` and `button "Overwrite"`. `Overwrite` saves the editor's text, and the file ends with `verified again` and no `external`.
- **Discard.** Type again and click `button "Close README.md tab"`. `dialog "Discard unsaved changes?"` offers `button "Cancel"` and `button "Discard and close"`. Discarding closes the tab and leaves the file on disk as last saved.
- **Create.** On `tab "Files"`, click `button "New file"`. A `treeitem "untitled"` with `textbox "Rename untitled"` appears. `agent-browser press Control+a`, type `new.ts` and press Enter. `tab "new.ts" [selected]` opens and the file exists in the scratch repo.
- **Rename.** Right-click `treeitem "new.ts"` as in Drive in `SKILL.md`. `menu "new.ts actions"` lists `Open`, `New file…`, `New folder…`, `Rename…`, `Delete…`, `Copy path` and `Copy relative path`. Choose `menuitem "Rename…"`, replace the text in `textbox "Rename new.ts"` with `renamed.ts`, and press Enter. The tab becomes `tab "renamed.ts"` and the file on disk is renamed.
- **Delete.** Right-click `treeitem "renamed.ts"` and choose `menuitem "Delete…"`. `dialog "Delete renamed.ts?"` says "You can’t undo this." Click `button "Delete"`. The row, its tab and the file are gone.
- **Search.** On `tab "Files"`, click `textbox "Search files"` and type `index`. The search box shows `1 of 1` on screen, but `snapshot -i` omits that counter. Drive on `button "Clear search"` and `treeitem "index.ts"`. `agent-browser press Enter` opens `tab "index.ts" [selected]`.

## Gotchas

- An edited tab's accessible name gains ` Unsaved changes`. Match on `tab "README.md` without the closing quote while it is dirty.
- Clicking the row of a file that already has a tab selects that tab instead of the Files tab. Click `tab "Files"` before the next tree action.
- `agent-browser get box` prints float `x`/`y`/`width`/`height`. Round the center to integers before `mouse move`; floats fail with "Missing arguments".
