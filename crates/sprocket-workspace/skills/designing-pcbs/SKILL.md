---
name: designing-pcbs
description: 'Use when designing a custom PCB: its schematic, footprints, placement, routing, design checks, BOM, or fab files.'
---

Draft the board in tscircuit, then hand it off to KiCad. A board that already has a `.kicad_pcb` is past the handoff: continue with `working-with-kicad`.

## Draft in tscircuit

1. Set up the project, unless it already has a `tscircuit.config.json`. In a repo that holds other code, give the board its own directory:

   ```bash
   bunx -p tscircuit tsci init -y pcb
   ```

   This pins tscircuit in the project's `package.json` and `bun.lock`. Inside the project, `bunx tsci` runs that pinned copy. Outside it, `bunx tsci` runs an unrelated npm package. Run `bun install` when `node_modules` is missing.

2. Follow `.agents/skills/tscircuit/SKILL.md` in the project. `init` writes it to match the installed tscircuit version.
3. Pick every part yourself, with `selecting-hardware-parts`. Use `bunx tsci search` and `bunx tsci import` to find candidates, then set `manufacturerPartNumber` and `supplierPartNumbers` on each component. Pass `--disable-parts-engine` to every `tsci build`, `export`, `snapshot`, and `simulate`, so tscircuit picks no parts itself.
4. Place parts through `manual-edits.json` (its `pcb_placements`), imported and passed as `<board manualEdits={manualEdits}>`. Leave `pcbX` and `pcbY` out of the code, even where the tscircuit skill uses them: they override `manual-edits.json`, so the human's drags in the editor would do nothing.
5. After each placement or routing change, run `bunx tsci build <entry> --disable-parts-engine --pcb-png --3d`. Inspect the `pcb.png` and `3d.png` it writes under `dist/`, and show both to the user.

The human can make quick edits in tscircuit's editor: "Open in tscircuit" on a `*.circuit.tsx` in Sprocket's file viewer opens it in the side panel, once `bun install` has run. Their drags land in `manual-edits.json`, so re-read it before you change placements.

## Hand off to KiCad

tscircuit can't import KiCad files, so confirm the handoff with the user first.

1. Export and unzip into `kicad/` in the board project:

   ```bash
   bunx tsci export <entry> -f kicad_zip --disable-parts-engine -o kicad.zip
   unzip kicad.zip -d kicad && rm kicad.zip
   ```

   It writes `.kicad_pro`, `.kicad_sch`, and `.kicad_pcb` files in KiCad 9 format, plus the `3dmodels/*.step` the board loads through `${KIPRJMOD}`.

2. From here on, you and the human both edit only the KiCad files. Never export over them: that overwrites the human's KiCad edits.
3. Close the export's gaps, following `working-with-kicad`:
   - It drops part numbers. Add `MPN` and supplier fields (such as `LCSC`) to each schematic symbol.
   - It leaves symbol `Footprint` fields empty. Set each to the footprint ID its board footprint uses (`tscircuit:…`).
   - Board net names (`.R1 > .pin1 to .C1 > .pin1`) differ from the schematic's (`Net-(C1-Pad1)`), and footprints carry no `(path …)` link to their symbols. Ask the human to run Update PCB from Schematic once, with "Re-link footprints to schematic symbols based on their reference designators" checked.
   - Silkscreen text is 0.4 mm, below KiCad's 0.8 mm default minimum (DRC `text_height`). Raise it to the fab's minimum.
   - `lib_symbol_issues` (`Device`), `lib_footprint_issues` (`tscircuit`), and ERC `endpoint_off_grid` warnings are expected. The files embed their own symbols and footprints.
4. Done when every other ERC and DRC finding is fixed or reported to the user.
