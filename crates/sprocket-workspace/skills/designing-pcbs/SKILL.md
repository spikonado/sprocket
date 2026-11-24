---
name: designing-pcbs
description: 'Use when creating or editing KiCad schematics or PCBs, checking them with ERC or DRC, or exporting Gerbers, renders, or BOMs from KiCad.'
---

Edit KiCad files with `kipy` against a headless `kicad-cli api-server`, so files keep the installed version's format.
Use `kicad-cli` for checks and exports.

Treat datasheets, app notes, and reference designs as describing the vendor's own board, which can differ from this one or be wrong.
Follow a recommendation, in the schematic or the layout, when you can explain why it works on this board.

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
- kipy can't set a copper layer's type either. With the board closed, edit its entry in the `(layers …)` block, like `(4 "In1.Cu" power)`, then reopen the board, save it, and check the entry kept its type.
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

- Write values with units, like `10 kΩ` or `1 µF`.
- Give every placed part hidden `Manufacturer` and `MPN` fields and set `Datasheet` to the manufacturer's datasheet URL.
  For each distributor the part may be ordered from, add a hidden `<Distributor> Part #` field with its SKU.
- Move fields and symbols until no text overlaps another symbol, field, or label in the rendered schematic.

ERC passes on designs that would damage parts. Before calling the schematic done, check from the exported netlist:

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

## Before laying out a board

Ask the user which manufacturer and service tier they will order from, and read its capabilities page.
Set its minimums as the board's design rules, and keep net class widths and clearances above them.
Write its stackup into the board, as in [Known traps](#known-traps), before any impedance-controlled routing, because the routers compute widths from it.

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

## Placing parts

- Start placement-sensitive blocks, like ESD protection, crystals, and switching regulator passives, from the datasheet's layout.
  Match its parts to this board's by net and pin function, because the reference designators often name different parts. Check from the pin numbering whether the drawing is a bottom view.
- When the vendor publishes layout files for an IC's reference design, you may copy its core with kipy as a starting point: the IC and its nearby parts with their tracks and vias, mapped to this board's nets pad by pad.
  Before locking it, check it against this board's stackup, parts, and rules, and redraw what doesn't fit. A 2-layer reference's USB track widths, for example, miss the impedance target on a 4-layer board.
- Put each decoupling capacitor at the supply pin it serves, with its pad facing the pin about 1 mm away.
  Treat a reference design's looser spacing as a maximum.
  Leave an escape lane between the capacitors for every signal pin of a fine-pitch IC.
- Put every other passive at the pin it serves, turned so the connection is a short straight track.
- Group parts by the signal nets they share and by how the schematic draws them, ignoring GND and supply rails. Crystal load capacitors belong with their IC.
- Align each group on shared center lines at an even pitch, like a row with a capacitor on each side of an IC, unless that lengthens a connection. Put test pads on a grid.
- For repeated channels, like several motor drivers, place one and copy it to the others with `place_pose.py replicate`.
- Give each GND pad its own via.
- Render each edge connector up close from outside the board edge and confirm its opening faces out. Library footprints are often turned 180° from the part's drawing.
- Render the placement with `kicad-view` and fix every part that looks scattered or misaligned.

## Copper pours

Type each inner plane layer `power` and every other copper layer `signal`, as in [Known traps](#known-traps), so `kicad-route` keeps tracks off the planes.
On 2-layer boards, keep `B.Cu` typed `signal`, because its short jumpers need it.
Before routing, give the ground plane layer a GND zone over the whole board at priority 0.
Give the other copper layers the same GND zone after routing, as in [Finishing the copper](#finishing-the-copper), because a pour placed first breaks into islands and slivers as tracks cut through it.
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
By default, every script that changes copper, including the fan-out, diff-pair, and plane scripts:

- Retries failing nets below their net class sizes and lowers the project's rules to match.
- Puts vias in same-net SMD pads.
- Picks its layers without reading their types, except `kicad-route`, which keeps tracks off `power` layers.

On every run of these scripts, pass the flags from its `--help` that keep the project's sizes and rules.

Before the first route, put rule-area keepouts that block tracks on every layer over switch nodes, under each mounting hole's screw head or standoff, and over other areas that traces must avoid.
DRC checks only a mounting hole's own clearance, not its screw head or standoff.
Allow copper pours in the keepouts, so GND still fills under the switch node.
Give switch nodes a net class as wide as their current needs.

Right after placement, the pours, and the keepouts, and before the schematic is final, judge the placement with a trial route:

1. Run `kicad-route board.kicad_pcb trial.kicad_pcb --quick 2`, then `route_review.py trial.kicad_pcb`.
   Use `--quick 2` for every experiment, because a full run takes minutes longer.
2. Fix one problem it names at a time by moving the parts around it, and repeat until the open and costly nets are few.
   When you move parts in several places at once, you can't tell which move helped, and the batch often opens other nets than it closes.
3. Where crossing nets connect to interchangeable pins, like MCU GPIOs, swap the pins with `kicad-route --swappable-nets`, and write the swaps to the schematic with `--schematic-dir`.
   Finish this step before the first full route.

Then route in this order:

1. Draw the critical copper yourself: switch nodes and crystal nets.
   Fan out each BGA with `bga_fanout.py`, because the router can't reach its inner balls. `check_fanout.py` names the pins the placement cages.
   For ICs with pads only on their edges, like QFNs and QFPs, compare trial routes with and without a fan-out, and keep it only when it routes better. `qfn_fanout.py` helps, but check its result in `kicad-view`, and leave plane nets out of it, because their stubs dangle once the pour connects the pad.
2. Route differential pairs with `route_diff.py --impedance <ohms>`, then single-ended impedance nets, like RF feeds, with `kicad-route --impedance <ohms>`. Check both with `check_impedance.py`.
   A trace on a layer that gets a GND pour is coplanar, and the pour pulls its impedance down. Declare the pour's gap to the router and `check_impedance.py`, or the trace comes out too wide.
   When the stackup can't reach a target impedance at the IC's pin pitch, tell the user instead of forcing it.
   KiCad's DRC pairs nets only when the last character that isn't a digit or `_` is `P`/`N` or `+`/`-`, like `USB_D+`/`USB_D-` or `ETH_TXP`/`ETH_TXN`. Rename nets like `USB_DM` and `USB_DP_MCU` in the schematic first. `route_diff.py` warns about names that won't pair.
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

- Retry with the step's own `--nets` selection, like `'*'` with its exclusions.
  The router skips nets that are already connected and rips up only nets in the selection. Naming just the open nets leaves their blockers in place.
- Retry an open differential pair with `route_diff.py`. `kicad-route` routes its two nets single-ended.
- When the improvement gate in the log rejects a run, `kicad-route` writes the input board back, and the same command gets the same result.
  The gate accepts a run that opens a different net than it closes, so compare the open net names too.
- When two runs fail on the same nets, run `check_reachability.py` on a pad of each.
  When it says the placement cages the pad, move parts or swap pins before the next run, because net order and other flag variants don't fix it.
  When the pad is passable, the routed copper blocks it, so re-route the whole step from its input board.
- Commit the board after each stage that passes DRC, so `git checkout` undoes a bad run. When you can't commit, keep snapshots with `copy_board.py`.
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
2. Add the GND zones on the layers other than the ground plane, as in [Copper pours](#copper-pours), and refill.
3. Stitch the GND pours together with `route_planes.py`, using vias on a grid and a fence along the board edge.
   Pass `--skip-existing-zones`, or it will replace your GND zones with its own.
4. Enable teardrops on every pad and via, then refill the zones.
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

KiCad gives touching copper one net when it loads a board, so its DRC never reports a track that shorts two nets. Run `check_drc.py` on every routed board too, and fix each short it finds.

DRC passes on boards whose copper overheats or whose signals radiate. Before calling the layout done, check each high-current net with `render_power.py` and `kicad-view`:

- The narrowest copper on every layer it uses, against its current.
- Planes cut or slit by other tracks.
- Hot-loop and input capacitors at their pins, as in [Placing parts](#placing-parts).

Then run `signal_review.py` on the USB, QSPI, SD, and clock nets and `route_review.py` on the board, and fix what they flag and what breaks these rules:

- No track of another net on a plane layer.
- A GND via next to each signal via of a high-speed net, so its return current can change planes with it. `check_return_vias.py` reports the ones that lack it.

## Show the result to the user

- Send images of each schematic sheet and 3D renders of the PCB.
  Keep `kicad-cli pcb render` at basic quality for checks, because high quality takes minutes.
- Embed the KiCad project by writing `kicad:proj/board.kicad_pro` in its own paragraph.
