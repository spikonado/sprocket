---
name: working-with-kicad
description: 'Use when creating or editing KiCad schematics or PCBs, or exporting from KiCad (Gerbers, renders, BOMs, ERC/DRC).'
---

Edit KiCad files with `kipy` against a headless `kicad-cli api-server`, so files keep the installed version's format.
Use `kicad-cli` for checks and exports.

## Set up the connector

- Check that KiCad is under "Installed connectors" in the workspace instructions. If it isn't, ask the user to install it in Settings → Connectors.
- The connector puts `kicad-python` (run API scripts with it), `kicad-cli`, `kicad`, and `kipy-api` on PATH. Call them by name.
- `kipy-api <module> [name ...]` lists the installed kipy's classes, signatures, and enums.
- KiCad's symbol, footprint, and 3D model libraries are in `$SPROCKET_KICAD_LIBRARIES`.

## Before editing

- Before the first save of an existing project, compare the file header's `(generator_version "…")` with the KiCad version from the connector.
  If the file is older, ask the user once: saving upgrades the format irreversibly, and only git can undo it.
- Open existing files with `open_document`. `create_document` replaces an existing file on save.

## Known traps

- ERC reports a missing library `''`, or the file gains `lib_name`s like `R_1`: `update_items` on a symbol sent with its `definition` forks its library link.
  Call `sym.proto.ClearField("definition")` before updating schematic symbols.
  Clearing it on a board footprint wipes its pads.
- DRC reports `lib_footprint_mismatch` on rotated footprints: the `orientation` setter truncates rotated coordinates by 1 nm.
  Pass `orientation=` to `place_footprint_from_library` instead.

## Designing the schematic

- Write values with units (`10 kΩ`, `1 µF`).
- Move fields and symbols until no text overlaps another symbol, field, or label in the rendered schematic.

## Designing the silkscreen

- Hide reference designators on the silkscreen.
  Library footprints keep a `${REFERENCE}` text on the Fab layer for assembly.
- Limit the silkscreen to footprint outlines, polarity marks, short connector pin labels, and the project's logo if it has one.
  Board documentation goes in the project's docs.

## 3D models

Give every component's footprint a 3D model whose file exists, so the 3D render shows each component's body.
When KiCad's libraries lack one, download the part's STEP model from its manufacturer or distributor, save it in the project, and reference it as `${KIPRJMOD}/…`.

## Checks

Run ERC and DRC after each save and fix every finding:

```bash
kicad-cli sch erc --severity-all --format json -o erc.json proj/board.kicad_sch
kicad-cli pcb drc --schematic-parity --severity-all --format json -o drc.json proj/board.kicad_pcb
```

## Show the result to the user

- Send images of each schematic sheet and 3D renders of the PCB.
- Embed the KiCad project by writing `kicad:proj/board.kicad_pro` in its own paragraph.
