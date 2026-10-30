---
name: designing-pcbs
description: 'Use when designing a custom PCB: its schematic, footprints, placement, routing, design checks, BOM, or fab files.'
---

Design boards with tscircuit, running its `tsci` CLI through Bun.

1. Set up the project, unless it already has a `tscircuit.config.json`. In a repo that holds other code, give the board its own directory:

   ```bash
   bunx -p tscircuit tsci init -y pcb
   ```

   This pins tscircuit in the project's `package.json` and `bun.lock`. Inside the project, run `bunx tsci`, which uses that pinned copy. Outside a tscircuit project, plain `bunx tsci` runs an unrelated npm package.

2. Follow `.agents/skills/tscircuit/SKILL.md` in the project. `init` writes it to match the installed tscircuit version.
3. Pick every part yourself, with `selecting-hardware-parts`. Use `bunx tsci search` and `bunx tsci import` to find candidates, then set `manufacturerPartNumber` and `supplierPartNumbers` on each component. Pass `--disable-parts-engine` to every `tsci build`, `export`, `snapshot`, and `simulate`, which keeps tscircuit from picking parts on its own.
4. After each placement or routing change, run `bunx tsci build <entry> --disable-parts-engine --pcb-png --3d`. Inspect the `pcb.png` and `3d.png` it writes under `dist/`, and show both to the user.
5. Write fab files with `bunx tsci export <entry> -f gerbers --disable-parts-engine -o <name>.zip`, also where the tscircuit skill points to the `tsci dev` export UI. The zip holds the Gerbers, drill file, `bom.csv`, and `pick_and_place.csv` that fabs such as JLCPCB take. Done when every `bom.csv` row carries the part numbers you chose.
