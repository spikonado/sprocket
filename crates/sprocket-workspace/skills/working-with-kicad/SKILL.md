---
name: working-with-kicad
description: 'Use when creating or editing KiCad schematics or PCBs, or exporting from KiCad (Gerbers, renders, BOMs, ERC/DRC).'
---

Edit KiCad files with `kipy` against a headless `kicad-cli api-server`, so files keep the installed version's format.
Use `kicad-cli` for checks and exports.

## Set up the connector

- Check that KiCad is under "Installed connectors" in the workspace instructions. If it isn't, ask the user to install it in Settings → Connectors.
- The connector puts `kicad-python`, `kicad-cli`, `kicad`, `kipy-api`, `kicad-route`, and `kicad-view` on PATH. Call them by name.
- Run every script with `kicad-python`. Its venv has kipy, numpy, scipy, shapely, and pillow. System `python3` and PyPI's `kicad-python` lack them or are too old.
- `kipy-api` lists the installed kipy's classes, signatures, and enums, as in `kipy-api board_types Zone`. Check it before writing kipy code.
- `kicad-view` renders one area of a board as a PNG with net names and DRC markers. Use it to look at placement, routing, and DRC findings.
- KiCad's libraries are in `$SPROCKET_KICAD_LIBRARIES`: one file per symbol in `symbols/<Lib>.kicad_symdir/<Symbol>.kicad_sym`, footprints in `footprints/<Lib>.pretty/`, and `3dmodels/`. Search for parts there.
- kipy uses nm, and DRC JSON and `kicad-view` use mm. All three use absolute board coordinates, not coordinates relative to the board origin.
- KiCadRoutingTools is in `$SPROCKET_KICAD_ROUTING_TOOLS`. `kicad-route` runs its `py_router/route.py`.
  Run its other scripts with `kicad-python "$SPROCKET_KICAD_ROUTING_TOOLS/<script>"` and read their `--help`.
  Use them before writing your own:

  | Script                                                        | Use                                                                               |
  | ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
  | `py_router/copy_board.py`                                     | Copy a board with its `.kicad_pro` and `.kicad_dru`                               |
  | `py_tools/board_brief.py`, `py_tools/board_context.py`        | Footprints, pads, and courtyards of a board                                       |
  | `py_tools/check_assembly.py`                                  | Whether a placement can be assembled                                              |
  | `py_router/route_planes.py`                                   | GND stitching vias and board-edge via fences                                      |
  | `py_router/route_diff.py`                                     | Differential pairs                                                                |
  | `py_router/qfn_fanout.py`, `py_router/bga_fanout.py`          | Escape routing for fine-pitch ICs                                                 |
  | `py_tools/route_review.py`                                    | After a route: open nets, costly nets, congested areas, and the parts to move     |
  | `py_tools/check_reachability.py`, `py_tools/net_forensics.py` | Why a pad or net won't route                                                      |
  | `py_tools/check_join.py`                                      | Check a hand-drawn track and via path against all copper                          |
  | `py_router/check_weird.py`                                    | Copper hygiene: removable segments, soft joints, dangling vias, narrow pad joints |
  | `py_tools/kicad_unconnected.py`                               | Exact unconnected count from DRC                                                  |
  | `py_tools/render_power.py`, `py_tools/analyze_power_paths.py` | Power paths and their copper                                                      |
  | `py_tools/render_nets.py`                                     | Compare chosen nets across several routed boards                                  |
  | `py_tools/pdf_text.py`                                        | Find, print, and render pages of a datasheet PDF                                  |

## Before editing

- Before the first save of an existing project, compare the file header's `(generator_version "…")` with the KiCad version from the connector.
  If the file is older, ask the user once: saving upgrades the format irreversibly, and only git can undo it.
- Open existing files with `open_document`. `create_document` replaces an existing file on save.

## Known traps

- ERC reports a missing library `''`, or the file gains `lib_name`s like `R_1`: `update_items` on a symbol sent with its `definition` forks its library link.
  Call `sym.proto.ClearField("definition")` before updating schematic symbols.
  Clearing it on a board footprint wipes its pads.
- Copies of a placed symbol made with `create_items` fork its library link into `R_1`..`R_4`. Place one with `place_symbol_from_library`, then create copies from its proto.
- DRC reports hundreds of `connection_width` violations after a zone fill: a new `Zone()` has 0 clearance and 0 mm thermal spokes.
  Set its clearance and a full pad connection, as in [Copper pours](#copper-pours).
- KiCad's Cleanup Tracks & Vias and other `run_action` calls fail in headless mode. Use the steps in [Finishing the copper](#finishing-the-copper).
- The Gerber job file lists placeholder dielectrics: kipy reads the stackup with `board.get_stackup()` but can't write it.
  With the board closed, edit the `(stackup …)` block inside `(setup)` in the `.kicad_pcb`, then reopen it and check `get_stackup()`.
- DRC on a renamed copy of a board ignores the project's rules: `kicad-cli` reads them from the `.kicad_pro` with the board's basename.
  Make copies with `copy_board.py`. For DRC without parity errors or `lib_footprint_issues`, also copy the `.kicad_sch` under the new basename and `fp-lib-table` next to it.
- A keepout inside a footprint ends up far from its part: setting `footprint.position` also moves the footprint's zones. Restore their outlines after a move and check keepouts in DRC.
- A Zone created with several outline polygons keeps only the first. Create one Zone per polygon.
- Setters on a new `NetClass()` raise. Copy the `Default` netclass's proto and edit the copy.
- `board.get_project()` fails after `open_document`. Pass the DocumentSpecifier that `open_document` returns to `KiCad.get_project()`.
- `get_pads()` returns paste-only pads with no net. Skip SMD pads without a net when matching pads to nets.
- `save()` fails with `failed to save schematic` for a sheet with a relative filename. Create the sheet with an absolute path, then rename it to the basename.
- Schematic items have no bounding box handler. Measure text with `get_text_extents`.
- `kipy-api` doesn't list proto enums. Text alignments like `HA_CENTER` are in `kipy.proto.common.types.enums_pb2`, and `ElectricalPinType` is in `kipy.proto.common.types.base_types_pb2`.
- Hierarchical net names start with the sheet path, like `/charger/CHG_PMID`. Match both forms when filtering nets.
- Teardrop counts change between refills. Refill twice before comparing DRC runs.
- Deleting every item that DRC flags as dangling opens T-junctions. Delete an item only when the net's connectivity stays the same without it.

## Designing the schematic

Treat datasheet and app note advice as describing the vendor's own evaluation board.
Follow a recommendation when you can explain why it works on this board.

- Write values with units, like `10 kΩ` or `1 µF`.
- Give every placed part hidden `Manufacturer` and `MPN` fields and set `Datasheet` to the manufacturer's datasheet URL.
  Add hidden `Digikey Part #`, `Mouser Part #`, `LCSC Part #`, and `JLCPCB Part #` fields if that distributor sells the part.
- Move fields and symbols until no text overlaps another symbol, field, or label in the rendered schematic.

ERC passes on designs that would damage parts. Before calling the schematic done, review each block from the exported netlist, with one read-only subagent per block, and check:

- Every pin against its absolute maximum ratings while unpowered, partly powered, and powered, including back-powering through connectors, sense pins, and I/O.
- Every adjustable or fixed-output regulator's feedback and ADJ wiring against the datasheet's output equation.
- Strap and boot pins, at the supply present when the IC samples them, including the pins the bootloader drives or pulls.
- Voltage tolerance of every I/O that sees another rail, like FT (5 V-tolerant) and TT (3.6 V-tolerant) pins.
- Each order in which the user can plug in cables, batteries, and supplies.
- Current limits and fuses at the minimum of their tolerance.

## Custom library parts

Look for a part in the stock libraries before drawing it.
kipy can't edit libraries, so write custom symbols and footprints as text:

- Copy the header and structure of a stock file, and keep its format version.
  `kicad-cli fp upgrade` converts a `.pretty` to the connector's newer format, which KiCad 10.0 can't read.
- Put them in the project and register them in `sym-lib-table` and `fp-lib-table` as `${KIPRJMOD}/lib/…`.
- Take pads from the land-pattern drawing in the datasheet, and compare every pad's position and size with your footprint.
- Confirm pin 1 of polarized connectors against the manufacturer's drawing or photos, and note the source in the footprint's description.
- Test each footprint on a scratch board that has the project's `fp-lib-table`: run DRC, then render it from the top and side to see the pins enter the pads.

## Manufacturer constraints

Before laying out a board, ask the user which manufacturer and service tier they will order from, and read its capabilities page.
Write its minimums with `board.set_design_rules()`, which saves them in the `.kicad_pro`.
Keep net class widths and clearances above them.

## Grounding

- Use one unbroken ground plane under the whole board.
  Above tens of kHz, return current flows in the plane directly under its trace, so placement keeps noisy currents away from quiet ones.
  Place the power stage, digital, and analog parts in separate areas, and route each area's signals only over that area, on every layer.
- Connect pins labeled AGND, DGND, PGND, or SGND to that plane right at the pin. The labels name currents inside the chip.
  The exception is a switching regulator whose datasheet asks for separate AGND and PGND: put its AGND pin and the controller's quiet parts, like the feedback divider and compensation, on a small top-layer AGND island.
  Join the island to PGND at one point, usually the exposed pad, through a net tie, and give the island no other connection to the plane.
- Split ground only for galvanic isolation, like mains or patient connections, and cross the gap only with isolators, optocouplers, or transformers.
- Give every high-speed trace a continuous reference plane along its whole length. Power planes may be split when no trace on an adjacent layer crosses the split.

## Copper pours

Before routing, give every copper layer a GND zone over the whole board at priority 0.
Put pours of other nets, like power planes and the AGND island, above it at higher priorities, so GND fills the copper they leave.
Keep one layer as the solid ground plane, with no other pours or traces: the inner layer next to `F.Cu` on boards with 4 or more layers, and `B.Cu` on 2-layer boards, where only short jumpers may cross it.
Keep switch node copper as small as its current allows, because its area radiates.

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
It routes on every copper layer by default, so on boards with 4 or more layers pass `--layers` with all of them and `--layer-costs` with `-1` for the ground plane layer on every run.
Pass `--escalation off --strict-sizes` on every run too. The default escalation retries failing nets below the board's clearance floor.
Put rule-area keepouts that block tracks on every layer over switch nodes and other areas that traces must avoid before the first route. Leave copper pours allowed in them, so GND still fills under the switch node.

Right after placement, the pours, and the keepouts, and before the schematic is final, judge the placement with a trial route:

1. Run `kicad-route board.kicad_pcb trial.kicad_pcb --quick 2`, then `route_review.py trial.kicad_pcb`.
2. Move the parts it names and repeat until the open and costly nets are few.
3. Where crossing nets connect to interchangeable pins, like MCU GPIOs, propose pin swaps to the user.
   Once they agree, `--swappable-nets 'GPIO*' --schematic-dir proj/` swaps the pins and writes the swaps to the schematic.
   Finish this step before the first full route.

Then route block by block: differential pairs first with `route_diff.py`, then one block at a time with `--component REF` or `--group BLOCK`.
Keep earlier blocks' copper with `--keep-input-copper`, and set `KICAD_RIP_PREEXISTING=0 KICAD_FINALIZE_RIP=0` so the router can't rip it up.

The exit code doesn't say whether every net routed, so run [DRC](#checks) on each output.
For each round of fixes:

- Route only what is still open: the nets DRC lists as unconnected with `--nets`, or one block with `--component` or `--group`.
- Read the run's last `JSON_SUMMARY_MIN` and `JSON_IMPROVEMENT_GATE` lines.
  When the gate rejects a run, `kicad-route` writes the input board back, and the same command gets the same result.
- When two runs fail on the same nets, move parts or swap pins before the next run. Net order and other flag variants don't fix them.
- Commit the board after each stage that passes DRC, so a bad run is one `git checkout` away. When you can't commit, keep snapshots with `copy_board.py`.
- Write board-generating scripts to be idempotent, and have them delete only copper they created.

Routes and DRC on a full board take minutes to hours:

- Start them with `exec_cmd` and a short `yieldTimeMs`, then wait with `poll_cmd`. Read their logs with `grep -a`.
- On machines with less than 32 GB of RAM, run one router, DRC, or solver at a time.
- Keep a `STATE.md` in the scratch directory that lists running jobs, what each variant tests, and the scratch scripts, so the work survives context compaction.

## Finishing the copper

Once DRC shows 0 unconnected items, finish the copper in this order and run DRC after each step:

1. Run `kicad-route board.kicad_pcb clean.kicad_pcb --nets '*' '!GND'`, excluding every zone net with `'!NET'`.
   With nothing left to route, it removes dead ends and redundant or duplicate segments. With nets still open, it routes them again, which can take 15 to 30 minutes.
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
When KiCad's libraries lack one, download the part's STEP model from its manufacturer or distributor, save it in `proj/lib/3d/`, and reference it as `${KIPRJMOD}/lib/3d/…`.

- `uvx easyeda2kicad --3d --lcsc_id C… --output proj/lib/3d/<name>` writes LCSC's 3D model to `<name>.3dshapes/`. Check its dimensions against the drawing.
- Generated STEP files differ byte for byte between runs. Regenerate them only when the geometry changes.

## Checks

Run ERC and DRC after each save and fix every finding:

```bash
kicad-cli sch erc --severity-all --format json -o erc.json proj/board.kicad_sch
kicad-cli pcb drc --refill-zones --schematic-parity --severity-all --format json -o drc.json proj/board.kicad_pcb
```

DRC passes on boards whose copper overheats. Before calling the layout done, check each high-current net with `render_power.py` and `kicad-view`:

- The narrowest copper on every layer it uses, against its current.
- Planes cut or slit by other tracks.
- Hot-loop and input capacitors as close to their pins as the datasheet and evaluation board place them.
- One via per GND pad, added at placement.

## Show the result to the user

- Send images of each schematic sheet and 3D renders of the PCB.
  `kicad-cli pcb render` at the default `--quality basic` and about 1200 px wide is enough for checks. `high` at 2400 px takes minutes.
- Embed the KiCad project by writing `kicad:proj/board.kicad_pro` in its own paragraph.
