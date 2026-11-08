---
name: working-with-kicad
description: 'Use when creating or editing KiCad schematics or PCBs, or exporting from KiCad (Gerbers, renders, BOMs, ERC/DRC).'
---

Edit KiCad files with `kipy` against a headless `kicad-cli api-server`, so files keep the installed version's format.
Use `kicad-cli` for checks and exports.

## Set up the connector

- Check that KiCad is under "Installed connectors" in the workspace instructions. If it isn't, ask the user to install it in Settings → Connectors.
- The connector puts `kicad-python`, `kicad-cli`, `kicad`, `kipy-api`, `kicad-route`, and `kicad-view` on PATH. Call them by name, and run API scripts with `kicad-python`.
- `kipy-api` lists the installed kipy's classes, signatures, and enums. Check it before writing kipy code.
- `kicad-view` renders one area of a board as a PNG with net names and DRC markers. Use it to look at placement, routing, and DRC findings.
- KiCad's symbol, footprint, and 3D model libraries are in `$SPROCKET_KICAD_LIBRARIES`.
- KiCadRoutingTools is in `$SPROCKET_KICAD_ROUTING_TOOLS`. `kicad-route` runs its `py_router/route.py`.
  Run its other scripts with `kicad-python "$SPROCKET_KICAD_ROUTING_TOOLS/<script>"` and read their `--help`:

  | Script                                               | Use                                                                               |
  | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
  | `py_router/route_planes.py`                          | GND stitching vias and board-edge via fences                                      |
  | `py_router/route_diff.py`                            | Differential pairs, before single-ended routing                                   |
  | `py_router/qfn_fanout.py`, `py_router/bga_fanout.py` | Escape routing for fine-pitch ICs                                                 |
  | `py_router/check_weird.py`                           | Copper hygiene: removable segments, soft joints, dangling vias, narrow pad joints |
  | `py_tools/route_review.py`                           | After a route: open nets, costly nets, congested areas, and the parts to move     |

## Before editing

- Before the first save of an existing project, compare the file header's `(generator_version "…")` with the KiCad version from the connector.
  If the file is older, ask the user once: saving upgrades the format irreversibly, and only git can undo it.
- Open existing files with `open_document`. `create_document` replaces an existing file on save.

## Known traps

- ERC reports a missing library `''`, or the file gains `lib_name`s like `R_1`: `update_items` on a symbol sent with its `definition` forks its library link.
  Call `sym.proto.ClearField("definition")` before updating schematic symbols.
  Clearing it on a board footprint wipes its pads.
- DRC reports hundreds of `connection_width` violations after a zone fill: a new `Zone()` has 0 clearance and 0 mm thermal spokes.
  Set its clearance and a full pad connection, as in [Copper pours](#copper-pours).
- KiCad's Cleanup Tracks & Vias and other `run_action` calls fail in headless mode. Use the steps in [Finishing the copper](#finishing-the-copper).
- The Gerber job file lists placeholder dielectrics: kipy reads the stackup with `board.get_stackup()` but can't write it.
  With the board closed, edit the `(stackup …)` block inside `(setup)` in the `.kicad_pcb`, then reopen it and check `get_stackup()`.
- DRC on a renamed copy of a board ignores the project's rules: `kicad-cli` reads them from the `.kicad_pro` with the board's basename.
  Copy the `.kicad_pro` and `.kicad_dru` next to the copy under its name.

## Designing the schematic

Treat datasheet and app note advice as describing the vendor's own evaluation board.
Follow a recommendation when you can explain why it works on this board.
When one conflicts with this board's return current paths or with this skill, tell the user which one you chose and why.

- Write values with units, like `10 kΩ` or `1 µF`.
- Give every placed part hidden `Manufacturer` and `MPN` fields and set `Datasheet` to the manufacturer's datasheet URL.
  Add hidden `Digikey Part #`, `Mouser Part #`, `LCSC Part #`, and `JLCPCB Part #` fields if that distributor sells the part.
- Move fields and symbols until no text overlaps another symbol, field, or label in the rendered schematic.

## Manufacturer constraints

Before laying out a board, ask the user which manufacturer and service tier they will order from, and read its capabilities page.
Write its minimums with `board.set_design_rules()`, which saves them in the `.kicad_pro`.
Keep net class widths and clearances above them.

## Grounding

- Use one unbroken ground plane under the whole board.
  Above tens of kHz, return current flows in the plane directly under its trace, so placement keeps noisy currents away from quiet ones.
  Place the power stage, digital, and analog parts in separate areas, and route each area's signals only over that area, on every layer.
- Connect pins labeled AGND, DGND, PGND, or SGND to that plane right at the pin. The labels name currents inside the chip.
- When a switching regulator's datasheet asks for separate AGND and PGND, put the controller's quiet parts, like the feedback divider and compensation, on a small top-layer AGND island.
  Join the island to PGND at one point, usually the exposed pad, through a net tie.
- Split ground only for galvanic isolation, like mains or patient connections, and cross the gap only with isolators, optocouplers, or transformers.
- Give every high-speed trace a continuous reference plane along its whole length. Power planes may be split when no trace on an adjacent layer crosses the split.

## Copper pours

Before routing, give every copper layer a GND zone over the whole board at priority 0.
Put pours of other nets, like power planes and switch nodes, above it at higher priorities, so GND fills the copper they leave.

```python
from kipy.board_types import Zone
from kipy.proto.board import board_types_pb2 as bt

zone = Zone()
zone.net, zone.layers, zone.priority = gnd, [layer], 0
zone.outline = board_outline  # PolygonWithHoles
zone.clearance = clearance_nm
zone.island_mode = bt.IRM_ALWAYS
zone.proto.copper_settings.connection.zone_connection = bt.ZCS_FULL
board.create_items([zone])
```

## Routing

Route the board with `kicad-route`.
It reads clearances and widths from the `.kicad_pro`, and connects the pads of zone nets, like `GND`, to their pours.
Put rule-area keepouts on every layer over switch nodes and other areas that traces must avoid before the first route.

Right after placement, and before the schematic is final, judge the placement with a trial route:

1. Run `kicad-route board.kicad_pcb trial.kicad_pcb --quick 2`, then `route_review.py trial.kicad_pcb`.
2. Move the parts it names and repeat until the open and costly nets are few.
3. Where crossing nets connect to interchangeable pins, like MCU GPIOs, propose pin swaps to the user.
   Once they agree, `--swappable-nets 'GPIO*' --schematic-dir proj/` swaps the pins and writes the swaps to the schematic.

`kicad-route` exits 0 even when nets fail, so run [DRC](#checks) on its output.
For each round of fixes:

- Route only what is still open: the nets DRC lists as unconnected with `--nets`, or one area with `--component REF` or `--group BLOCK`.
- Read the run's last `JSON_SUMMARY_MIN` and `JSON_IMPROVEMENT_GATE` lines.
  When the gate rejects a run, `kicad-route` writes the input board back. Change the placement or the flags before the next run, because the same command gets the same result.
- Commit the board after each stage that passes DRC, so a bad run is one `git checkout` away.
- Write board-generating scripts to be idempotent, and have them delete only copper they created.

## Finishing the copper

Once every net is routed, finish the copper in this order and run DRC after each step:

1. Run `kicad-route board.kicad_pcb clean.kicad_pcb --nets '*'` once more.
   With nothing left to route, it removes dead ends and redundant or duplicate segments.
   Then run `check_weird.py` on the result and fix what it reports.
2. Stitch the GND pours together with `route_planes.py`, using vias on a grid and a fence along the board edge.
   Pass `--skip-existing-zones`, or it replaces your GND zones with its own.
3. Enable teardrops on every pad and via, then refill the zones.
   Edit pads through `footprint.definition.pads` and send the footprints to `update_items`. Sending pads from `get_pads()` changes nothing.
   Teardrops go stale when copper moves, so add them as the last copper change.

## Designing the silkscreen and fab layers

- Hide reference designators on the silkscreen.
  Library footprints keep a `${REFERENCE}` text on the Fab layer for assembly.
- Limit the silkscreen to footprint outlines, polarity marks, short connector pin labels, and the project's logo if it has one.
  Board documentation goes in the project's docs.
- Hide the Value field of every footprint whose Value sits on `F.Fab` or `B.Fab`, so the fab layers show each part's outline and reference.
  The BOM carries the values.
- Render `F.Fab` and `B.Fab` with the `Edge.Cuts` outline using `kicad-cli pcb export png`.
  Move or shrink each `${REFERENCE}` text until it sits inside its part's outline without overlapping another.

## 3D models

Give every component's footprint a 3D model whose file exists, so the 3D render shows each component's body.
When KiCad's libraries lack one, download the part's STEP model from its manufacturer or distributor, save it in the project, and reference it as `${KIPRJMOD}/…`.

## Checks

Run ERC and DRC after each save and fix every finding:

```bash
kicad-cli sch erc --severity-all --format json -o erc.json proj/board.kicad_sch
kicad-cli pcb drc --refill-zones --schematic-parity --severity-all --format json -o drc.json proj/board.kicad_pcb
```

## Show the result to the user

- Send images of each schematic sheet and 3D renders of the PCB.
- Embed the KiCad project by writing `kicad:proj/board.kicad_pro` in its own paragraph.
