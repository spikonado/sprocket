---
name: designing-pcbs
description: 'Use when creating or editing KiCad schematics or PCBs, checking them with ERC or DRC, or exporting Gerbers, renders, or BOMs from KiCad.'
---

Edit KiCad files with `kipy` against a headless `kicad-cli api-server`, so files keep the installed version's format.
Use `kicad-cli` for checks and exports.

## Set up the connector

- Check that KiCad is under "Installed connectors" in the workspace instructions. If it isn't, ask the user to install it in Settings → Connectors.
- Run every script with `kicad-python`, whose venv has kipy and the routing tools. System `python3` and PyPI's `kicad-python` lack them or are too old.
- Check `kipy-api <module>`, like `kipy-api board`, before writing kipy code. It lists the installed kipy's classes, methods, and enums.
- Look at placement, routing, and DRC findings with `kicad-view`, which renders one area of a board as a PNG.
- KiCad's stock libraries are in `$SPROCKET_KICAD_LIBRARIES`.
- kipy uses nm, and DRC JSON and `kicad-view` use mm. All three use absolute board coordinates, not coordinates relative to the board origin.
- KiCadRoutingTools is in `$SPROCKET_KICAD_ROUTING_TOOLS`, and `kicad-route` runs its `py_router/route.py`.
  The scripts this skill names are in its `py_router/` or `py_tools/`. Read a script's `--help` before its first run.
  Before writing a board script, look for one in the Project Structure section of its `README.md`.

## Before editing

- Before the first save of an existing project, compare the file header's `generator_version` with `kicad-cli version`.
  If the file is older, ask the user once, because saving upgrades the format and their KiCad may no longer open it.
- Open existing files with `open_document`. `create_document` replaces an existing file on save.

## Known traps

- ERC reports a missing library `''`, or the file gains `lib_name`s like `R_1`, because `update_items` on a symbol sent with its `definition` forks its library link.
  Call `sym.proto.ClearField("definition")` before updating schematic symbols.
  Clearing it on a board footprint wipes its pads.
- Copies of a placed symbol made with `create_items` fork its library link into `R_1`..`R_4`. Place one with `place_symbol_from_library`, then create copies from its proto.
- KiCad's Cleanup Tracks & Vias and other `run_action` calls fail in headless mode. Use the steps in [Finishing the copper](#finishing-the-copper).
- The Gerber job file lists placeholder dielectrics because kipy reads the stackup with `board.get_stackup()` but can't write it.
  With the board closed, edit the `(stackup …)` block inside `(setup)` in the `.kicad_pcb`, then reopen it and check `get_stackup()`.
- DRC on a renamed copy of a board ignores the project's rules, because `kicad-cli` reads them from the `.kicad_pro` with the board's basename.
  Make copies with `copy_board.py`. For DRC without parity errors or `lib_footprint_issues`, also copy the `.kicad_sch` under the new basename and `fp-lib-table` next to it.
- A Zone created with several outline polygons keeps only the first when saved. Create one Zone per polygon.
- Project calls like `get_net_classes()` fail with `the requested project … is not open`, whichever way you get the `Project`.
  With the board closed, copy the `Default` entry in the `.kicad_pro`'s `net_settings.classes`, edit the copy, and reopen the board.
- `get_pads()` returns paste-only pads with no net. Skip SMD pads without a net when matching pads to nets.
- `save()` fails with `failed to save schematic` for a sheet with a relative filename. Create the sheet with an absolute path, then rename it to the basename.
- Schematic items have no bounding box handler. Measure text with `get_text_extents`.
- Teardrop counts change between refills. Refill twice before comparing DRC runs.
- Deleting every item that DRC flags as dangling opens T-junctions. Delete an item only when the net's connectivity stays the same without it.

## Designing the schematic

Treat datasheet and app note advice as describing the vendor's own evaluation board.
Follow a recommendation when you can explain why it works on this board.

- Write values with units, like `10 kΩ` or `1 µF`.
- Give every placed part hidden `Manufacturer` and `MPN` fields and set `Datasheet` to the manufacturer's datasheet URL.
  For each distributor the part may be ordered from, add a hidden `<Distributor> Part #` field with its SKU.
- Move fields and symbols until no text overlaps another symbol, field, or label in the rendered schematic.

ERC passes on designs that would damage parts. Before calling the schematic done, review each block from the exported netlist, with one read-only subagent per block, and check:

- Every pin against its absolute maximum ratings while unpowered, partly powered, and powered, including back-powering through connectors, sense pins, and I/O.
- Every adjustable or fixed-output regulator's feedback and ADJ wiring against the datasheet's output equation.
- Strap and boot pins, at the supply present when the IC samples them, including the pins the bootloader drives or pulls.
- Voltage tolerance of every I/O that sees another rail, like FT and TT pins.
- Each order in which the user can plug in cables, batteries, and supplies.
- Current limits and fuses at the minimum of their tolerance.

## Custom library parts

Draw a part only when the stock libraries lack it.
kipy can't edit libraries, so write custom symbols and footprints as text:

- Copy the header and structure of a stock file, and keep its format version.
  `kicad-cli fp upgrade` converts a `.pretty` to the connector's nightly format, which released KiCad versions can't read.
- Put them in the project and register them in `sym-lib-table` and `fp-lib-table` as `${KIPRJMOD}/lib/…`.
- Take pads from the land-pattern drawing in the datasheet, and compare every pad's position and size with your footprint.
- Confirm pin 1 of polarized connectors against the manufacturer's drawing or photos, and note the source in the footprint's description.
- Test each footprint on a scratch board that has the project's `fp-lib-table`: run DRC, then render it from the top and side to see the pins enter the pads.

## Manufacturer constraints

Before laying out a board, ask the user which manufacturer and service tier they will order from, and read its capabilities page.
Set its minimums as the board's design rules, and keep net class widths and clearances above them.

## Grounding

- Use one unbroken ground plane under the whole board, with no other pours or traces on its layer.
  On boards with 4 or more layers, it is the inner layer next to `F.Cu`. On 2-layer boards, it is `B.Cu`, and only short jumpers may cross it.
  Above tens of kHz, return current flows in the plane directly under its trace, so placement keeps noisy currents away from quiet ones.
  Place the power stage, digital, and analog parts in separate areas, and route each area's signals only over that area, on every layer.
- Connect pins labeled AGND, DGND, PGND, or SGND to that plane right at the pin. The labels name currents inside the chip.
  The exception is a switching regulator whose datasheet asks for separate AGND and PGND: put its AGND pin and the controller's quiet parts, like the feedback divider and compensation, on a small top-layer AGND island.
  Join the island to PGND at one point, usually the exposed pad, through a net tie, and give the island no other connection to the plane.
- Split ground only for galvanic isolation, like mains or patient connections, and cross the gap only with isolators, optocouplers, or transformers.
- Give every high-speed trace a continuous reference plane along its whole length.
  On 4-layer boards, `B.Cu` traces return through the inner power plane, so keep it as solid as the ground plane.

## Placing parts

- Copy the datasheet's layout for placement-sensitive blocks, like ESD protection, crystals, and switching regulator passives.
- When the vendor publishes layout files for an IC's reference design, copy its core with kipy instead of redrawing it: the IC, its regulator, crystal, flash, USB, and decoupling parts with their tracks and vias.
  Pair each reference footprint with the part on this board that replaces it, and map each reference net to this board's net on the same pad number.
  Then apply one rigid transform and the net map to every copied track, arc, and via, and lock them.
- Put each decoupling capacitor at the supply pin it serves, with its pad facing the pin about 1 mm away.
  Treat a reference design's looser spacing as a maximum.
  Leave an escape lane between the capacitors for every signal pin of a fine-pitch IC.
- Put every other passive at the pin it serves, turned so the connection is a short straight track.
- Group related parts and align them on shared center lines at an even pitch, like a row with a capacitor on each side of an IC. Put test pads on a grid.
- Give each GND pad its own via.
- Render the placement with `kicad-view` and fix every part that looks scattered or misaligned.

## Copper pours

Before routing, give every copper layer a GND zone over the whole board at priority 0.
Put pours of other nets, like power planes and the AGND island, above it at higher priorities, so GND fills the copper they leave.
Keep switch node copper as small as its current allows, because its area radiates.

A new `Zone()` has 0 clearance and 0 mm thermal spokes, so DRC reports hundreds of `connection_width` violations after a fill. Set its clearance and a full pad connection:

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
It connects the pads of zone nets, like `GND`, to their pours.
On every run:

- Pass `--escalation off --strict-sizes`. Otherwise, the router retries failing nets below their net class sizes and lowers the project's rules to match.
- On boards with 4 or more layers, keep tracks off every plane: pass every copper layer to `--layers` and `-1` for each plane in `--layer-costs`, like `--layers F.Cu In1.Cu In2.Cu B.Cu --layer-costs 1 -1 -1 1`.
  When nets stay open, fix the placement, the fan-out, or the board size. Never raise a plane's cost to let tracks onto it.

Before the first route, put rule-area keepouts that block tracks on every layer over switch nodes and other areas that traces must avoid. Allow copper pours in them, so GND still fills under the switch node.
Give switch nodes a net class as wide as their current needs.

Right after placement, the pours, and the keepouts, and before the schematic is final, judge the placement with a trial route:

1. Run `kicad-route board.kicad_pcb trial.kicad_pcb --quick 2`, then `route_review.py trial.kicad_pcb`.
   Use `--quick 2` for every experiment, because a full run takes minutes longer.
2. Move the parts it names and repeat until the open and costly nets are few.
3. Where crossing nets connect to interchangeable pins, like MCU GPIOs, propose pin swaps to the user.
   Once they agree, `kicad-route --swappable-nets` swaps the pins, and `--schematic-dir` writes the swaps to the schematic.
   Finish this step before the first full route.

Then route in this order:

1. Draw the critical copper yourself: switch nodes, crystal nets, and a fan-out that takes each fine-pitch IC pin to a via outside the pad ring, never in a pad.
   `qfn_fanout.py` helps, but check its result in `kicad-view`.
2. Route differential pairs with `route_diff.py --impedance <ohms>`, then check them with `check_impedance.py`.
   `route_diff.py` pairs nets only when the last character that isn't a digit or `_` is `P`/`N` or `+`/`-`, like `USB_D+`/`USB_D-` or `ETH_TXP`/`ETH_TXN`. Rename nets like `USB_DM` and `USB_DP_MCU` in the schematic first.
3. Lock the tracks, arcs, and vias from the steps above, so the router never rips them.
4. Route everything else in one run with `--keep-input-copper`. Plan buses and nets that share a destination as bundles with `--bus`.
   Routing block by block leaves more nets open than one global run.

The router leaves right angles and stray jogs, so look at each block in `kicad-view` and fix the copper that breaks these rules:

- Make every bend 135° or wider, and join branches at 45°, preferably at a pad or via.
- Leave each pad and via from its center in a straight line until the track clears its copper, and keep each track heading toward its destination.
- Run tracks that go the same way within about 0.5 mm of each other, side by side at the clearance rule.
- Stagger vias so bundled tracks stay together up to their ends.
- Make every gap either the clearance rule or wide enough for another track plus clearance, so pours leave no slivers or islands.

The exit code doesn't say whether every net is routed, so run [DRC](#checks) on each output.
For each round of fixes:

- Route only what is still open: the nets DRC lists as unconnected with `--nets`.
- When the improvement gate in the log rejects a run, `kicad-route` writes the input board back, and the same command gets the same result.
  The gate accepts a run that opens a different net than it closes, so compare the open net names too.
- When two runs fail on the same nets, move parts or swap pins before the next run. Net order and other flag variants don't fix them.
- Commit the board after each stage that passes DRC, so a bad run is one `git checkout` away. When you can't commit, keep snapshots with `copy_board.py`.
- Write board-generating scripts to be idempotent, and have them delete only copper they created.

Routes and DRC on a full board take minutes to hours:

- Read their logs with `grep -a`.
- On machines with less than 32 GB of RAM, run one router, DRC, or solver at a time.
- Keep a `STATE.md` in the scratch directory that lists running jobs, what each variant tests, and the scratch scripts, so the work survives context compaction.

## Finishing the copper

Once DRC shows 0 unconnected items, finish the copper in this order and run DRC after each step:

1. Run `kicad-route board.kicad_pcb clean.kicad_pcb --nets '*' '!GND'`, excluding every zone net with `'!NET'`.
   With nothing left to route, it removes dead ends and redundant or duplicate segments. With nets still open, it routes them again.
   Then run `check_weird.py` on the result and fix what it reports.
2. Stitch the GND pours together with `route_planes.py`, using vias on a grid and a fence along the board edge.
   Pass `--skip-existing-zones`, or it will replace your GND zones with its own.
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

- `uvx easyeda2kicad --3d` downloads LCSC's model for a part's LCSC number. Check its dimensions against the drawing.
- Generated STEP files differ byte for byte between runs. Regenerate them only when the geometry changes.

## Checks

Run ERC and DRC after each save and fix every finding:

```bash
kicad-cli sch erc --severity-all --format json -o erc.json proj/board.kicad_sch
kicad-cli pcb drc --refill-zones --schematic-parity --severity-all --format json -o drc.json proj/board.kicad_pcb
```

DRC passes on boards whose copper overheats or whose signals radiate. Before calling the layout done, check each high-current net with `render_power.py` and `kicad-view`:

- The narrowest copper on every layer it uses, against its current.
- Planes cut or slit by other tracks.
- Hot-loop and input capacitors at their pins, as in [Placing parts](#placing-parts).

Then check the signals from the board file, because `route_review.py` reports none of these:

- No track of another net on a plane layer.
- USB, QSPI, SD, and clock nets at most about 1.5 times their straight-line length, with at most 2 vias each.
- Each differential pair coupled along its length and at its target impedance.
- Switch nodes at their net class width, with no vias.
- No vias in SMD pads, unless the user chose the manufacturer's filled and capped vias.

Fix every failure in the layout, or tell the user which ones remain and why.

## Show the result to the user

- Send images of each schematic sheet and 3D renders of the PCB.
  Keep `kicad-cli pcb render` at basic quality for checks, because high quality takes minutes.
- Embed the KiCad project by writing `kicad:proj/board.kicad_pro` in its own paragraph.
