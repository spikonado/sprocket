---
name: working-with-kicad
description: 'Use when creating or editing KiCad schematics or PCBs, or exporting from KiCad (Gerbers, renders, BOMs, ERC/DRC).'
---

Use `kipy` and `kicad-cli api-server` to edit KiCad files.

## Set up the connector

- Check if KiCad is listed in `list_connectors`. If it isn't, ask the user to install it in Settings -> Connectors.
- The connector puts `kicad-python` (run API scripts with it), `kicad-cli`, and `kicad` on PATH.

## Before editing

- Before the first save of an existing project, compare the file header's `(generator_version "…")` with the KiCad version from the connector.
  If the file is older, ask the user once: saving upgrades the format irreversibly, and only git can undo it.

## Script shape

- Use one headless server per script.
- Units are nanometers; build points with `Vector2.from_xy_mm` and lengths with `from_mm`.
- Y increases downward in both editors.

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

- `open_document` loads an existing file. `create_document` starts an empty one (plus the `.kicad_pro`) and replaces an existing file on save, so use it only for new files.
  A server holds one schematic and one board.
- `load_all_libraries` loads the library tables in the background; anything that reads libraries fails until `wait_for_libraries` returns.
  Calls block during the load, and kipy's default 2 s timeout fails them, hence `timeout_ms`.
- Look up library IDs with `kicad.get_library_symbols(["Device"])` and `kicad.get_library_footprints(["Resistor_SMD"])`; each item's `str()` is the ID.

## Designing the schematic

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

- Place every symbol before the first `update_items`.
  Placing a symbol after updating another instance of it forks its library link (`R_1`, ERC `lib_symbol_issues`).
- Pass `reference=` to every placement, power symbols included (`#PWR01`, `#FLG01`); unset references can come back duplicated.
- Put symbol origins and wire ends on the 1.27 mm grid, or ERC reports `endpoint_off_grid`.
- Give every symbol a footprint before the board step.
  Power nets use `power:` symbols (`power:GND`, `power:VCC`) with `value` set to the net name.
- Put a `power:PWR_FLAG` on each power net fed from a connector or off-board, or ERC reports `power_pin_not_driven`.
- `pin_end` handles rotation but not mirroring, so leave symbols unmirrored.
- Use local labels between blocks and global labels only across sheets.
- Passive values should have units (`10 kΩ`, `100 nF`) and about 10 mm between neighbouring power symbols so their names don't overlap.
- `sch.get_netlist()` lists net names only.
  Check pin-level connections in the exported `.net` file's `(node (ref …) (pin …))` entries.

## Designing the board

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
    fp.reference_field.visible = False
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

- Place footprints yourself before the import; `NMM_REFERENCE` links them by reference and assigns nets.
  Footprints the import adds land near the origin.
  Rotating an existing footprint through `update_items` leaves rounding drift that DRC reports as `lib_footprint_mismatch`, so set orientation at placement.
  Pass `layer=BoardLayer.BL_B_Cu` for the back.
- Pad positions are absolute; re-read footprints after moving them.
- A `Via` has zero size until you set `diameter` and `drill_diameter`.
- Footprints missing from `fp.definition.models` render without a body.
  Save the part's STEP under `proj/3dmodels/` and attach it with `fp.definition.add_item()` of a `Footprint3DModel` whose `filename` is `${KIPRJMOD}/3dmodels/<file>.step`, then `update_items([fp])`.
  Set `visible`, `opacity = 1`, and `scale = Vector3D.from_xyz(1, 1, 1)`; a new model's scale is 0.

## Designing silkscreen

- Hide reference designators in the silkscreen; ensure they are present in the Fab layer's `${REFERENCE}` text instead.
- Don't clutter the silkscreen by using it as a place to write documentation about the board.
- Add connector pin labels and similar.
- Add the project's logo, if it has one.

## Suggested checks

```bash
kicad-cli sch erc --severity-all --format json -o erc.json proj/board.kicad_sch
kicad-cli pcb drc --schematic-parity --severity-all --format json -o drc.json proj/board.kicad_pcb
```

## Show the result to the user

- Send images of the schematic(s) and 3D renders of the PCB.
- Link to the KiCad project by writing `kicad:proj/board.kicad_pro` in a new paragraph.
