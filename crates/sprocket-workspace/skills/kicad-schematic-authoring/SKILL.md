---
name: kicad-schematic-authoring
description: 'Guide on authoring valid .kicad_sch / .kicad_pro files as text: the live KiCad s-expression format and kicad-cli validation. Use when writing, generating, or editing a KiCad schematic or project by hand. Only use when the user explicitly requests KiCAD or PCBs.'
---

This skill is about producing **file-format-correct** KiCad schematics, i.e. what eeschema itself would write.
This skill is not an electronics-design course; circuit facts come from current datasheets, and supplier descriptions, not from memory. Check with `scrape_url` / `web_search`.

## Ground truth order

1. The **installed** KiCad symbol libraries (`share/kicad/symbols/*.kicad_sym`)
   for symbol bodies, pins, and footprints. Never hand-invent a symbol body.
2. `kicad-cli sch upgrade` on a stub, to learn the live `(version …)` and the
   instance dialect this KiCad emits.
3. The shipped demos (`share/kicad/demos/**`) for sheet-level structure:
   `sheet_instances`, `title_block`, `.kicad_pro` `sheets`, but not for cached
   symbol bodies, which can lag the live libraries.

Match what eeschema writes; do not invent a parallel dialect.

Circuit facts (pin names/numbers, strapping-pin behavior, regulator
capacitor values, USB CC resistor values, reset timing, …) change and are
vendor data. Check the current datasheet / hardware-design guidelines for the
specific part with `scrape_url` / `web_search` instead of relying on memory,
and prefer values from the vendor's own reference design when one exists.

## Authoring steps

### 1. Learn the live version before writing

Demo `(version …)` / `(generator_version …)` often predate the installed
KiCad; copying them makes eeschema warn and rewrite on save. Write a stub
(see §Validate), `chmod u+w` it (Nix-store copies stay `0444`), run
`kicad-cli sch upgrade`, and read the header it produces. Use that version.

### 2. Embed `lib_symbols` from the installed libraries

- Only the **top-level** symbol gets the `Lib:Name` id; unit drawings keep
  the **short** name. `(symbol "Device:R" … (symbol "R_0_1" …))` is right;
  `Device:R_0_1` -> `Failed to load schematic`.
- Library files indent top-level symbols with one tab; under `(lib_symbols`
  they need **two**. Extract the symbol **including its leading tab**, then
  add one tab to every line. Do not strip tabs and re-indent from scratch.
- Flatten `(extends …)` before embedding: walk to the root that owns
  graphics/pins, copy that body, rename the top-level symbol and its `_0_1` /
  `_1_1` units to the **leaf** name, overlay the leaf's property values, drop
  `(extends …)`, and prefix the top-level name only. Many regulators and
  connectors are aliases with no pins of their own.

### 3. Place instances; compute pin positions from the library

Schematic coordinates: **Y increases downward**. Symbol library coordinates:
**Y increases upward**. For an instance at `(at_x, at_y)` rotated `rot`:

```python
import math

def pin_abs(at_x, at_y, at_rot_deg, pin_x, pin_y):
    a = math.radians(at_rot_deg)
    rx = pin_x * math.cos(a) - pin_y * math.sin(a)
    ry = pin_x * math.sin(a) + pin_y * math.cos(a)
    return at_x + rx, at_y - ry
```

Wire endpoints, labels, and power stubs must use these absolute pin ends, not
the symbol origin. Verify the Y sign on an asymmetric part (transistor C/E,
MCU VDD/GND); a resistor alone is a mirror and proves nothing.

Keep the fields eeschema emits on instances: `body_style`, `in_pos_files`,
property `show_name` / `do_not_autoplace`, quoted uuids, `(hide yes)`
placement after `(at …)`.

#### Instance reference/value visibility (hard rules)

- **`#PWR…` References of power symbols are always hidden**: `(hide yes)`
  on every one. A visible `#PWR01` on the sheet is a defect; eeschema never
  shows them. Their `Value` (the net name) stays visible.
- `Footprint`, `Datasheet`, `Description`, `ki_*` on every symbol are hidden.
- Component `Reference` / `Value` stay visible; place them deliberately
  (for vertical passives: ~+5.08 mm in X, ref above center, value below)
  instead of relying on `fields_autoplaced`.
- Write passive values with units and no space: `10kΩ`, not `10k` or `10 kΩ`.

### 4. Wire with short stubs; connect blocks with labels

Keep wire segments to short stubs only (about one grid to a few mm):
pin↔pin inside a tight cluster, pin↔power-symbol, or the stub under a
local label. Cross-block nets use **paired local labels** (same name on both
ends), not routed wires. Power nets use power symbols, not long `+3V3` wires.
One name per net: a second label on an already-labeled net ->
`multiple_net_names`.

#### Local labels on pins

Label `(at x y rot)` sits **on the pin connection point**; draw a short
horizontal stub under the text, from the pin outward in the direction the
text faces. Leave the stub tip open (ERC `unconnected_wire_endpoint` there
is expected for this style).

| Pin opens…                       | Label `(at … rot)` | `justify`      | Stub             |
| -------------------------------- | ------------------ | -------------- | ---------------- |
| to the **right** (pin `rot 180`) | pin xy, `rot 0`    | `left bottom`  | pin → pin+(L, 0) |
| to the **left** (pin `rot 0`)    | pin xy, `rot 180`  | `right bottom` | pin-(L, 0) → pin |

Stub length `L ≈ len(name) × 1.27` (font size). Mid-cluster labels on a
junction can stay `rot 0` / `left bottom` with no stub.

#### Global labels on pins (different from locals)

Global labels are for signals crossing sheets (locals are sheet-scoped).
Placement: stub of **exactly one grid step (1.27 mm)** from the pin outward,
`global_label` at the **stub tip** (not on the pin), `justify left` (pin
opens right, `rot 0`) or `justify right` (pin opens left, `rot 180`), with no
`bottom`. Set `(shape …)` to the role (`bidirectional` for GPIO-style nets).
Globals carry a hidden `Intersheetrefs` property sharing the label's `(at)`.

### 5. Power symbols

For power inputs/outputs, place power-library symbols and set `Value` to the
net name (a named tap like `+VOUT` reuses `power:+5V`). Do not sit a power
symbol directly on a pin end: offset one grid step (1.27 mm) along the lead
and connect with a short stub. Keep `Value` on the open side (`+5V` above,
`GND` below). Reference hidden; see §3 hard rules.

### 6. Layout: zone the sheet

Give each functional block empty area; gutter ≥ ~2.54 mm between bodies, more
around large modules. Put pull-ups, buttons, LEDs, and decoupling caps in
clear space, not parked on a large symbol's outline, and connect back with
local labels or rail power symbols. Before finishing: no two non-power
symbols share an origin, and no two body bounding boxes intersect.

### 7. Wire the project ↔ sheet UUID

These must be identical: the root schematic `(uuid "…")`, the `.kicad_pro`
`sheets: [[ "<uuid>", "Root" ], …]` entry, and every symbol instance
`(path "/<uuid>" (reference "U1") …)`. A mismatch doesn't always fail the
load, but annotation and ERC get confused.

## Validate

Before a full board, embed one symbol (e.g. `Device:R`) into a stub sheet and
run:

```bash
chmod u+w stub.kicad_sch
kicad-cli sch upgrade stub.kicad_sch
kicad-cli sch erc stub.kicad_sch
```

If upgrade cannot load the file, fix unit naming / indent / extends before
adding instances and wires. Then, on the full sheet:

```bash
kicad-cli sch upgrade board.kicad_sch   # header matches installed KiCad
kicad-cli sch erc board.kicad_sch       # review findings
kicad-cli sch export netlist board.kicad_sch
```

Run ERC, then still read the netlist: confirm every intended net (each module pin,
each header pin, each rail) actually carries the nodes you meant. Geometry
check: no shared origins, no intersecting bodies.

Ignore `power_pin_not_driven` when the circuit is otherwise fine. Omit
`PWR_FLAG` unless the user asks for power flags.
