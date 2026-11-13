# Artifacts

An artifact is a markdown, HTML, React, json-render or wiring document an agent saves for the project. A reply line `artifact:<id>` renders as a card, and the side panel's Artifacts view lists the project's artifacts, previews one, shows its source, opens it fullscreen and deletes it.

## Sub-features

- `artifact-card` shows a reference card in the reply whose `View` opens the artifact in the side panel.
- `artifact-list` lists the project's artifacts in the Artifacts view.
- `artifact-view` previews an artifact, toggles its source and copies it.
- `artifact-fullscreen` shows it over the whole window and leaves with Escape.
- `artifact-delete` deletes it from the open view's actions button or the list row's context menu.

## How to get to it (user POV)

- Ask an agent for an artifact, then choose `View` on its card.
- Open the side panel and choose `Artifacts` in a new tab.

## Driving it with agent-browser

Precondition: the dev `tiers` table has rows, as in [threads.md](./threads.md).

- **Create.** Send the one prompt in [transcript.md](./transcript.md), or ask the agent to save a markdown artifact titled `Verify note` with content `# Hello`, then reply with `artifact:<its id>` on its own line. The agent writes `/tmp/verify-sprocket-scratch/Verify note.md` and binds it, so the title becomes the file name `Verify note.md`. The reply shows a card with `Verify note.md`, `Artifact` and `button "View Verify note.md"`.
- **Open from card.** Click `button "View Verify note.md"`. The side panel opens `tab "Verify note.md" [selected]` with the type `markdown` and `heading "Hello"`. Markdown has no source toggle.
- **Fullscreen.** Click `button "Open fullscreen"`. Plain `snapshot` shows `dialog "Verify note.md fullscreen. Press Escape to exit."`. Escape closes it.
- **List.** Click `button "Back to artifacts"`. The tab becomes `tabpanel "Artifacts"` with one `button "<title> <type>"` per artifact. An empty project shows `No artifacts yet.`
- **Source.** Open an `html`, `react` or `json-render` row. It has `button "Show source"`, which shows the raw text and becomes `button "Show preview"`. An HTML or React preview is `Iframe "<title> preview"`.
- **Wiring.** Ask the agent for a wiring diagram of an ESP32 driving one motor through a TB6612 driver, saved as `robot.wiring.json`. Its row has type `wiring`. Every part is a box with named pins on its left and right sides. The preview shows one button per step plus `button "Show all"`, coloured right-angle wires, a `N of M wires done` checklist and a `Parts` list. No two wires share a stretch or a corner. A dashed wire with an amber "had no free path" warning means routing failed. Hovering a checklist row thickens its wire, and clicking a part shows only its wires. In the transcript, the `apply_patch` and `bind_artifact` results carry `wiringIssues`, and the final ones hold only warnings the agent explains in step notes. A `wiringCheckError` counts as a failed check.
- **Live edits.** Keep `robot.wiring.json` open, and open the same project in a second browser session. Have the agent change a step's title with `apply_patch`. Its result carries `wiringIssues`, and both previews update without a refresh. Repeat with `Verify note.md` and its heading. Bind another scratch artifact, then delete it, and both open lists update live.
- **Delete.** Right-click the `Verify note.md` row as in Drive in `SKILL.md`, or click `button "Verify note.md actions"` in the open view. `menu "Verify note.md actions"` has `menuitem "Delete artifact"`. Click it. The row leaves the list, the card leaves the transcript, and `/tmp/verify-sprocket-scratch/Verify note.md` is deleted.

## Gotchas

- The browser reads artifacts only from Convex, so a live update in the second session proves the local server synced the edit.
- Artifacts belong to the project's repository, so the list includes other threads' artifacts. Delete only the one this run made.
