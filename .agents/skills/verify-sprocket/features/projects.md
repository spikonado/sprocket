# Projects

A project is a local directory attached to this machine's server profile. New threads run in the selected project.

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
- For adding, a directory made with `$V/scratch-repo.sh /tmp/verify-sprocket-projects`. Reuse that path, since the app can't remove projects. Re-adding an attached path reuses its entry.
- The empty state needs a profile with no projects. The shared profile already has them, so `project-add-empty` is unreachable without a fresh `SPROCKET_VERIFY_DATA_DIR` and a new sign-in.

- **Open menu.** Click `button "Select project. Current project: <name>"`. Each project is a `menuitemradio` named after it, the current one `[checked=true]`, followed by `menuitem "Add project"`.
- **Open picker.** Click `menuitem "Add project"`. `dialog "Add project"` shows `button "Go to parent directory"`, `combobox "Project directory path"` with value `~/`, `button "Add Ctrl Enter"`, and `listbox "Directories"` with one `option` per subdirectory.
- **Enter path.** Click the combobox, `agent-browser press Control+a`, then `agent-browser keyboard type "/tmp/verify-sprocket-projects/"`. The listbox shows `option "src"`.
- **Add.** `agent-browser press Control+Enter`. The dialog closes and the heading reads `What should we build in Select project. Current project: verify-sprocket-projects`.
- **Side effect.** `python3 -m json.tool ~/.sprocket-dev-verify/project-attachments.json` has an entry with `"workspacePath": "/tmp/verify-sprocket-projects"` and `"displayName": "verify-sprocket-projects"`.
- **Switch.** Open the heading menu and choose `menuitemradio "verify-sprocket-scratch"`. The heading names `verify-sprocket-scratch` again.
- **Sidebar.** Click `button "Create or add project"`. `dialog "Add project"` opens. `agent-browser press Escape` closes it.

## Gotchas

- A second directory with the same git remote as an attached project is rejected with "Repository is already attached to <path>" in the error banner, and the picker still closes. Scratch repos have no remote, so each becomes its own project.
- `Enter` in the path box opens the highlighted directory. Only `Control+Enter` adds.
- A path that doesn't exist yet turns the button into `Create & add Ctrl Enter`.
