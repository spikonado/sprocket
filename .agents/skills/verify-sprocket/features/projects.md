# Projects

A project is a local directory the user attaches to their account. New threads run in the selected project.

## Sub-features

- `project-add-empty` adds the first project from the empty state.
- `project-add-menu` adds another project from the heading's project menu.
- `project-switch` picks a different project for the next thread.

## How to get to it (user POV)

- With no projects, choose `Add project` under "What should we work on?".
- With projects, open the heading's `Select project. Current project: <name>` button and choose `menuitem "Add project"`.
- In the sidebar, choose `button "Create or add project"`.

## Driving it with agent-browser

Preconditions:

- On the new-thread screen.
- For adding, an unattached directory made with `$V/scratch-repo.sh /tmp/verify-sprocket-<name>`. Only add one when the change under test needs a fresh project; it stays in the dev account for good.

- **Open picker.** Click `button "Add project"`. The picker shows `button "Go to parent directory"`, `combobox "Project directory path"` with value `~/`, `button "Add Ctrl Enter"`, and `listbox "Directories"` with one `option` per subdirectory.
- **Enter path.** Click the combobox, `agent-browser press Control+a`, then `agent-browser keyboard type "<path>"`.
- **Add.** `agent-browser press Control+Enter`. The picker closes and the heading reads `What should we build in Select project. Current project: <name>`, with `button "Select project. Current project: <name>"`.
- **Side effect.** `python3 -m json.tool ~/.sprocket-dev-verify/project-attachments.json` has an entry with `"workspacePath": "<path>"` and `"displayName": "<name>"`.
- **Switch.** Click the heading button. Each project is a `menuitemradio` named after it, and the current one is `[checked=true]`. Choose another and check the heading text changes.

## Gotchas

- A directory whose git remote matches an existing project attaches to that project and shows its name. That is correct behavior. Scratch repos have no remote, so each becomes its own project.
- `Enter` in the path box picks the highlighted directory. Only `Control+Enter` adds.
