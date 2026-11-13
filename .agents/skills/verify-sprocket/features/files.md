# Files

The Files view in the side panel shows the selected project's tree. Opening a file adds an editor tab, and saving writes the file to disk. `.kicad_pro`, `.kicad_sch` and `.kicad_pcb` open a KiCanvas viewer instead of the text editor. A board, or a project with one, also gets a 3D view rendered from KiCad's glTF export. The tree also creates, renames and deletes files. A Thread/Project toggle appears only when the open thread's cwd differs from the project path.

## Sub-features

- `files-tree` lists the project's directories and files.
- `files-open` opens a file in its own editor tab.
- `files-kicad` opens KiCad board, schematic and project files in KiCanvas.
- `files-kicad-3d` shows a board in 3D, and re-exports it when the `.kicad_pcb` changes.
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
- **KiCad.** On `tab "Files"`, write a small board into the scratch repo (`printf '%s\n' '(kicad_pcb (version 20240108) (generator "pcbnew") (general (thickness 1.6)) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)))' > /tmp/verify-sprocket-scratch/board.kicad_pcb`), click `button "Refresh files"`, then click `treeitem "board.kicad_pcb"`. `tab "board.kicad_pcb" [selected]` shows `Iframe "KiCanvas viewer for board.kicad_pcb"`, not a `textbox`. The same iframe title pattern holds for `.kicad_pro` and `.kicad_sch`. There is no unsaved-dot / Control+s path. Cleanup resets the scratch files.
- **KiCad 3D.** Needs the KiCad connector in the `~/.sprocket-dev-verify` profile: `Settings`, `Connectors`, `button "Install"`, which takes about a minute when the machine's own KiCad is on PATH. Without it, 3D shows an `alert` "Install the KiCad connector in Settings to view boards in 3D." Open a board with footprints, such as a template copied from `~/.sprocket/connectors/kicad/<version>/kicad/share/kicad/template/`. Click `button "3D"` in `group "Board view"`. A `status` "Building the 3D model with KiCad…" shows for the export, about 20 s for a 2 MB board, then a canvas with the board. Drag on it to orbit. `button "2D"` and back to `button "3D"` makes no new `POST /api/workspace/file/board-3d` in `network requests`. Editing the `.kicad_pcb` on disk shows `status` "Updating…" and then the new board at the same camera angle.
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
- On the new-thread screen, and on a thread whose cwd is the project, there is no `group "Files root"`. `button "Thread"` / `button "Project"` show only when `threadCwd` and the project path both exist and differ.
