# Projects

A project is a local directory attached to this machine's server profile. New threads run in the selected project.

## Sub-features

- `project-add-empty` adds the first project from the empty state.
- `project-add-menu` adds another project from the heading's project menu.
- `project-switch` picks a different project for the next thread.
- `project-inbox-filter` filters the inbox to one project or all of them.
- `project-remove` detaches a project from the inbox filter or the add-project chips.

## How to get to it (user POV)

- With no projects, choose `Add project` under "What should we work on?".
- With projects, open the heading's `Select project. Current project: <name>` button and choose `menuitem "Add project"`.
- In the sidebar, choose `button "Create or add project"`.
- In the sidebar, open `All projects` and pick one project, or `All projects` again.
- Remove a project with `button "Remove <name> from project list"` in that filter, or on a recent chip in `dialog "Add project"`.

## Driving it with agent-browser

Preconditions:

- On the new-thread screen.
- For adding, a directory made with `$V/scratch-repo.sh /tmp/verify-sprocket-projects`. Reuse that path. Re-adding an attached path reuses its entry. Removing it from the list, then adding the same path, creates a new attachment.
- The empty state needs a profile with no projects. The shared profile already has the user's real projects, so `project-add-empty` is unreachable without a fresh `SPROCKET_VERIFY_DATA_DIR` and a new sign-in. Do not remove `sprocket`, `ai-gateway`, or `verify-sprocket-scratch` from the shared profile.

- **Open menu.** Click `button "Select project. Current project: <name>"`. Each project is a `menuitemradio` named after it, the current one `[checked=true]`, followed by `menuitem "Add project"`.
- **Open picker.** Click `menuitem "Add project"`. `dialog "Add project"` shows `button "Go to parent directory"`, `combobox "Project directory path"` with value `~/`, `button "Add Ctrl Enter"`, one button per attached project such as `button "verify-sprocket-scratch"` that fills in its path, each with a sibling `button "Remove <name> from project list"`, and `listbox "Directories"` with one `option` per subdirectory.
- **Enter path.** Click the combobox, `agent-browser press Control+a`, then `agent-browser keyboard type "/tmp/verify-sprocket-projects/"`. The listbox shows `option "src"`.
- **Add.** `agent-browser press Control+Enter`. The dialog closes and the heading reads `What should we build in Select project. Current project: verify-sprocket-projects`.
- **Side effect.** `python3 -m json.tool ~/.sprocket-dev-verify/project-attachments.json` has an entry with `"workspacePath": "/tmp/verify-sprocket-projects"` and `"displayName": "verify-sprocket-projects"`.
- **Switch.** Open the heading menu and choose `menuitemradio "verify-sprocket-scratch"`. The heading names `verify-sprocket-scratch` again.
- **Sidebar.** Click `button "Create or add project"`. `dialog "Add project"` opens. `agent-browser press Escape` closes it.
- **Inbox filter.** Unsettled already lists threads from more than one project. The closed control is `DisclosureTriangle "All projects"` in plain `snapshot` and is omitted from `snapshot -i`. Open it with `agent-browser find text "All projects" click`. Then `snapshot -i` shows `textbox "Search projects"`, `button "All projects"`, one button per project, and each project's `button "Remove <name> from project list"`. Click `button "verify-sprocket-scratch"`. The menu closes, the disclosure heading becomes `verify-sprocket-scratch`, and `region "Unsettled"` keeps that project's rows while a sprocket row such as `Project Exploration Overview` is gone. Reopen with `agent-browser find text "verify-sprocket-scratch" click --exact`, take fresh refs, then click `button "All projects"`. The sprocket row returns.
- **Remove.** Open the filter and click `button "Remove verify-sprocket-projects from project list"`. The row is gone, and `project-attachments.json` no longer has that `workspacePath`. Re-add it from **Enter path** / **Add** so the shared profile still has the scratch project.

## Gotchas

- Adding a second directory with the same git remote as an attached project fails with "Repository is already attached to <path>" in the error banner, and the picker still closes. Scratch repos have no remote, so each becomes its own project.
- `Enter` in the path box opens the highlighted directory. Only `Control+Enter` adds.
- A path that doesn't exist yet turns the button into `Create & add Ctrl Enter`.
- After filtering to a project whose name is a substring of another visible label (`sprocket` vs `verify-sprocket-scratch`), put `--exact` after the action: `agent-browser find text "sprocket" click --exact`. `--exact` before `click` is parsed as the action and fails. Without `--exact`, `find text` clicks the heading.
