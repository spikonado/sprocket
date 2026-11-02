---
name: working-with-kicad
description: 'Use when creating or editing KiCad schematics or PCBs, or exporting from KiCad (Gerbers, renders, BOMs, ERC/DRC).'
---

Edit KiCad files through KiCad's Python API (kipy) against a headless
`kicad-cli api-server`, and use `kicad-cli` for checks and exports, so every
file is written in the installed version's format.

## 1. Check the connector

Call `list_connectors`. If KiCad isn't listed, ask the user to install it in
Settings → Connectors and stop KiCad work until they confirm. When it is
listed, these commands are on PATH:

- `kicad-python`: Python with kipy. Run every API script with it.
- `kicad-cli`: ERC, DRC, exports, renders, file upgrades.
- `kicad`: the GUI. Run it only when the user asks to open a project.

## 2. Before editing

- The user may have the same files open in the KiCad GUI; tell them to
  reload after you save.
- Before the first save of an existing project, compare the file header's
  `(generator_version "…")` with the installed KiCad version. If the file is
  older, ask the user once: saving upgrades the format irreversibly, and only
  git can undo it.
- Circuit facts (pinouts, strapping pins, regulator capacitors, USB CC
  resistors, reset timing) come from the part's current datasheet and the
  vendor reference design.

## 3. Script shape

One headless server per script. Units are nanometers; build points with
`Vector2.from_xy_mm` and lengths with `from_mm`. Y increases downward in both
editors.

```python
from kipy import KiCad
from kipy.proto.common.types import DocumentType

with KiCad(headless=True, timeout_ms=60000) as kicad:
    kicad.open_document("/abs/proj/board.kicad_sch", DocumentType.DOCTYPE_SCHEMATIC)
    kicad.load_all_libraries()
    kicad.wait_for_libraries(timeout_s=300)
    sch = kicad.get_schematic()      # kicad.get_board() for the PCB
    ...
    sch.save()
```

- `open_document` loads an existing file. `create_document` starts an empty
  one (plus the `.kicad_pro`) and replaces an existing file on save, so use
  it only for new files. A server holds one schematic and one board.
- `load_all_libraries` loads the library tables in the background; anything
  that reads libraries fails until `wait_for_libraries` returns. Calls block
  during the load, and kipy's default 2 s timeout fails them, hence
  `timeout_ms`.
- Edits use `create_items`, `get_items`, `update_items`, `remove_items` on the
  schematic or board. Mutate the objects these return, then `update_items`.
- Look up library IDs before using them: `kicad.get_library_symbols(["Device"])`
  and `kicad.get_library_footprints(["Resistor_SMD"])` return items whose
  `str()` is the ID, such as `Device:R`.

## 4. Schematic first

```python
from kipy.geometry import Vector2
from kipy.schematic_types import (
    LocalLabel, SchematicLine, SchematicLineType,
    SchematicLabelSpinStyle, SchematicSymbolOrientation,
)

r1 = sch.place_symbol_from_library(
    "Device:R", Vector2.from_xy_mm(100.33, 80.01),
    orientation=SchematicSymbolOrientation.SSO_90, reference="R1")
gnd = sch.place_symbol_from_library(
    "power:GND", Vector2.from_xy_mm(110.49, 90.17), reference="#PWR01")
# ...place every symbol, then edit fields in one update
r1.value = "10kΩ"
r1.footprint_field.text.value = "Resistor_SMD:R_0603_1608Metric"
sch.update_items([r1])

def pin_end(sym, number):
    p = next(p for p in sym.definition.pins if p.number == number).position
    x, y = {
        SchematicSymbolOrientation.SSO_0: (p.x, p.y),
        SchematicSymbolOrientation.SSO_90: (p.y, -p.x),
        SchematicSymbolOrientation.SSO_180: (-p.x, -p.y),
        SchematicSymbolOrientation.SSO_270: (-p.y, p.x),
    }[sym.transform.orientation]
    return Vector2.from_xy(sym.position.x + x, sym.position.y + y)

wire = SchematicLine()
wire.type = SchematicLineType.SLT_WIRE
wire.start = pin_end(r1, "1")
wire.end = wire.start + Vector2.from_xy_mm(2.54, 0)
label = LocalLabel()
label.text.value = "SDA"
label.position = wire.end
label.spin_style = SchematicLabelSpinStyle.SLSS_RIGHT
sch.create_items([wire, label])
```

- Place every symbol before the first `update_items`. Placing a symbol after
  updating another instance of it forks its library link (`R_1`, ERC
  `lib_symbol_issues`).
- Pass `reference=` to every placement, power symbols included (`#PWR01`,
  `#FLG01`); unset references can come back duplicated.
- Put symbol origins and wire ends on the 1.27 mm grid, or ERC reports
  `endpoint_off_grid`.
- Give every symbol a footprint before the board step. Power nets use
  `power:` symbols (`power:GND`, `power:VCC`) with `value` set to the net
  name. Put a `power:PWR_FLAG` on each power net fed from a connector or
  off-board, or ERC reports `power_pin_not_driven`.
- A pin connects where its end touches a wire. `pin_end` maps the local,
  Y-down pin positions in `definition.pins` through rotation but not
  mirroring, so leave symbols unmirrored.
- Style: short wire stubs, local labels between blocks, global labels only
  across sheets, one name per net, a clear gutter around each functional
  block, passive values with units and no space (`10kΩ`, `100nF`). Leave
  about 10 mm between neighbouring power symbols so their names don't
  overlap.
- `sch.get_netlist()` lists net names only. Check pin-level connections in
  the exported `.net` file's `(node (ref …) (pin …))` entries.

## 5. Board from the netlist

```python
from kipy.board_types import BoardLayer, BoardSegment, Track, Via, Zone
from kipy.geometry import Angle, PolygonWithHoles, PolyLine, PolyLineNode
from kipy.proto.board.board_commands_pb2 import NetlistMatchMode
from kipy.util import from_mm

sch.save()   # exporting a never-saved schematic crashes the server
sch.export_netlist("/abs/proj/board.net")
kicad.create_document("/abs/proj/board.kicad_pcb", DocumentType.DOCTYPE_PCB)
board = kicad.get_board()
for ref, lib_id, x, y, deg in [("R1", "Resistor_SMD:R_0603_1608Metric", 111, 106, 90), ...]:
    fp = board.place_footprint_from_library(
        lib_id, Vector2.from_xy_mm(x, y), orientation=Angle.from_degrees(deg))
    fp.reference_field.text.value = ref
    board.update_items([fp])
result = board.import_netlist("/abs/proj/board.net", match_mode=NetlistMatchMode.NMM_REFERENCE)
print(result.report)   # check result.error_count
fps = {f.reference_field.text.value: f for f in board.get_footprints()}
pad = {f"{ref}.{p.number}": p for ref, f in fps.items() for p in f.definition.pads}

corners = [Vector2.from_xy_mm(x, y) for x, y in [(100, 102), (118, 102), (118, 113), (100, 113)]]
edges = []
for a, b in zip(corners, corners[1:] + corners[:1]):
    edge = BoardSegment()
    edge.start, edge.end, edge.layer = a, b, BoardLayer.BL_Edge_Cuts
    edges.append(edge)
t = Track()
t.start, t.end = pad["J1.1"].position, pad["R1.1"].position
t.width, t.layer, t.net = from_mm(0.25), BoardLayer.BL_F_Cu, pad["J1.1"].net
via = Via()
via.position, via.net = Vector2.from_xy_mm(108, 109.5), pad["J1.2"].net
via.diameter, via.drill_diameter = from_mm(0.6), from_mm(0.3)
outline = PolyLine()
for corner in corners:
    outline.append(PolyLineNode.from_point(corner))
zone = Zone()
zone.layers, zone.net = [BoardLayer.BL_B_Cu], pad["J1.2"].net
zone.outline = PolygonWithHoles()
zone.outline.outline = outline
board.create_items(edges + [t, via, zone])
board.refill_zones()
board.save()
```

- Place footprints yourself before the import; `NMM_REFERENCE` links them by
  reference and assigns nets. Footprints the import adds land near the
  origin. Rotating an existing footprint through `update_items` leaves
  rounding drift that DRC reports as `lib_footprint_mismatch`, so set
  orientation at placement. Pass `layer=BoardLayer.BL_B_Cu` for the back.
- Pad positions are absolute; re-read footprints after moving them.
- Route every net yourself; there is no autorouter. Change layers with a
  `Via`; it has zero size until you set `diameter` and `drill_diameter`.

## 6. Check, show, export

Run checks after each save and fix every finding before moving on:

```bash
kicad-cli sch erc --severity-all --format json -o erc.json proj/board.kicad_sch
kicad-cli pcb drc --schematic-parity --severity-all --format json -o drc.json proj/board.kicad_pcb
kicad-cli sch export png -e -o out/ proj/board.kicad_sch
kicad-cli pcb render --side top -o out/top.png proj/board.kicad_pcb
```

Look at the PNGs yourself, and show them in the thread after each meaningful
change. When the project is ready for the user, embed it with
`kicad:proj/board.kicad_pro` in its own paragraph so they can explore it.
For fabrication, `kicad-cli pcb export gerbers -l
F.Cu,B.Cu,F.Mask,B.Mask,F.Paste,B.Paste,F.Silkscreen,B.Silkscreen,Edge.Cuts`
(without `-l` it plots every user layer too), then `pcb export
drill|pos|step` and `sch export bom`.
