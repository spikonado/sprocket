# tscircuit editor

A `*.circuit.tsx` file tab offers `Open in tscircuit`. That starts the project's own `tsci dev` and shows it in a side-panel tab through Sprocket's proxy at `/api/tscircuit/dev/<id>/`.

## Sub-features

- `tscircuit-open` opens the editor tab from a circuit file tab.
- `tscircuit-reload` shows edits made on disk without a manual reload.
- `tscircuit-write` saves the editor's file writes into the project.

## How to get to it (user POV)

- Open a `*.circuit.tsx` file from the Files view and click `Open in tscircuit` above the editor.

## Driving it with agent-browser

Precondition: a tscircuit project with `node_modules` installed sits in the scratch repo, for example `cp -r` of a `bunx -p tscircuit tsci init -y pcb` project, followed by `bun install`, into `/tmp/verify-sprocket-scratch/pcb`.

- **Open.** In Files, open `treeitem "pcb"`, then `treeitem "index.circuit.tsx"`. The tab shows `button "Open in tscircuit"`. Click it. A second `tab "index.circuit.tsx" [selected]` opens with `button "Reload tscircuit"`, `link "Open tscircuit in a new tab"` and `Iframe "tscircuit editor"`. Within about 10 s the iframe shows `button "Dev server connected"` and `tab "Schematic"`. `ss -ltnp | grep bun` shows the server on `127.0.0.1` only.
- **Reload.** Click `tab "Schematic"`, then add `<resistor resistance="10k" footprint="0402" name="R2" />` to the file on disk. R2 appears in the schematic within about 10 s.
- **Write.** From `agent-browser eval`, POST `{"file_path":"proxy-write.txt","text_content":"x"}` to the iframe's base path plus `api/files/upsert`. It returns 200 and the file appears in `pcb/` a second or two later. The page's response has the `content-security-policy` from `routes/tscircuit.rs` and `referrer-policy: no-referrer`.

## Gotchas

- Headless Chrome has no WebGPU, so the PCB tab shows "WebGPU rendering failed". Drive the Schematic tab. Dragging parts happens in the PCB tab, so it can't be driven headless.
- The console's "Failed to fetch latest eval version" is the CSP blocking jsdelivr, as intended.
- The server log is `~/.sprocket-dev-verify/tscircuit-dev/<id>.log`.
- `git clean -fd` in cleanup removes the copied project, including `node_modules`.
