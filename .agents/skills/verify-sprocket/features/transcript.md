# Transcript rendering

How a reply renders in `region "Conversation history"`: code blocks with copy and wrap, images with a preview dialog, mermaid diagrams, `html-visual` and `jsx-visual` pages, `json-render` blocks, `kicad:<path>` project cards, and the work disclosure over tool calls. `region "Running commands"` above the composer lists commands an agent left running.

## Sub-features

- `transcript-code` adds a language icon and copy and line-wrap buttons to fenced code.
- `transcript-image` shows markdown images and opens one in a preview dialog.
- `transcript-mermaid` renders a mermaid fence as a diagram.
- `transcript-visual` renders `html-visual` and `jsx-visual` fences in a sandboxed iframe, and `json-render` fences with the app's components.
- `transcript-kicad` shows a card for a `kicad:<path>.kicad_pro` line that opens the project in the side panel.
- `transcript-work` groups tool calls under a work disclosure that is open while the run works and collapses after.
- `transcript-running` lists running commands and stops one.

## How to get to it (user POV)

- Open a thread whose replies contain these blocks.

## Driving it with agent-browser

Precondition: an open thread, and the dev `tiers` table has rows, as in [threads.md](./threads.md). Write a project file first: `printf '{"meta":{"filename":"verify.kicad_pro","version":1}}\n' > /tmp/verify-sprocket-scratch/verify.kicad_pro`.

- **One prompt.** This send also covers the artifact in [artifacts.md](./artifacts.md) and the PR link in [threads.md](./threads.md): `Do these in order. 1) Save a markdown artifact titled Verify note whose content is "# Hello". 2) Start the shell command sleep 300 in the background and do not wait for it. 3) Call link_prs with repository github.com/spikonado/sprocket and number 1073. 4) Reply with exactly these blocks, each separated by a blank line: a ts fenced code block with const a = 1; then an html-visual fenced block with <p>visual ok</p> then a small json-render block that shows the text json ok then a mermaid block with graph TD; A-->B then the line kicad:/tmp/verify-sprocket-scratch/verify.kicad_pro then the line artifact:ID with the saved artifact id then the image ![shot](https://avatars.githubusercontent.com/u/9919?s=64).` It takes about a minute.
- **Work.** While the run works, the latest tool group is `[expanded=true]`, for example `button "Applied 1 patch"`. After the run, one button sums the group, such as `button "Ran 1 command; Applied 1 patch; Linked 1 PR group; Bound 1 artifact" [expanded=false]`. Clicking it lists each call, with the command as `DisclosureTriangle "sleep 300"`.
- **Code.** The block shows `image "TypeScript"`, `button "Enable line wrapping"` and `button "Copy code"`. Clicking wrap renames it `button "Disable line wrapping"` with `aria-pressed` `true`. Clicking copy sets the button's inner `status` to `Copied`.
- **Visual.** `Iframe "Visual"` holds `paragraph "visual ok"`. Plain `snapshot` prints the frame's content in place, so no `frame` switch is needed.
- **json-render.** The block renders as app text `json ok`, falling back to the source when the spec is invalid.
- **Mermaid.** The fence first shows as source, then as a `graphics-document` with `A` and `B` once mermaid.js paints. If rendering fails, it shows `Could not render diagram.` above the source.
- **KiCad card.** The card shows `verify`, `KiCad project` and `button "View verify"`. Click it. The side panel opens `tab "verify.kicad_pro" [selected]` with `Iframe "KiCanvas viewer for verify.kicad_pro"`.
- **Image.** The image is `button "View shot"`. Click it. `dialog "Image preview: shot"` has `button "Close image preview"` and, for a remote URL, `link "Open original image"`. Escape closes it.
- **Running commands.** After the reply, `region "Running commands"` sits above the composer with `button "Running commands" [expanded=false]` and the count `1`. Click it. The row shows `sleep 300`, the directory `/tmp/verify-sprocket-scratch` and `button "Stop command: sleep 300"`. Click Stop. The region goes away and `pgrep -af "sleep 300"` finds nothing.

## Gotchas

- The first code block after Vite starts with a cold dependency cache logs `optimized dependencies changed. reloading` and reloads the page, which drops back to the new-thread screen. Reopen the thread from `Unsettled`.
- `agent-browser clipboard read` fails with `Read permission denied`. Prove a copy with the `Copied` status.
