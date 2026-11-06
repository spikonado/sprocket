# Draws a two-resistor schematic through a headless kipy session, imports its netlist into a
# board, routes it with KiCadRoutingTools, runs ERC and DRC on the saved files, then renders it with kicad-view.
# Usage: KICAD_CLI_PATH=<kicad-cli> python smoke-test.py <kicad template dir> <routing tools dir>
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from kipy import KiCad
from kipy.geometry import Angle, Vector2
from kipy.proto.board.board_commands_pb2 import NetlistMatchMode
from kipy.proto.common.types import DocumentType
from kipy.schematic_types import LocalLabel, SchematicLabelSpinStyle, SchematicLine, SchematicLineType

FOOTPRINT = "Resistor_SMD:R_0805_2012Metric"

cli = os.environ["KICAD_CLI_PATH"]
version = subprocess.run([cli, "version"], check=True, capture_output=True, text=True).stdout
major, minor = version.split(".")[:2]

template = Path(sys.argv[1])
routing_tools = Path(sys.argv[2])
work = Path(tempfile.mkdtemp())
config = work / "config"
version_config = config / f"{major}.{minor}"
version_config.mkdir(parents=True)
for table in ("fp-lib-table", "sym-lib-table"):
    shutil.copy(template / table, version_config / table)
os.environ["KICAD_CONFIG_HOME"] = str(config)

schematic_path = work / "smoke.kicad_sch"
netlist_path = work / "smoke.net"
board_path = work / "smoke.kicad_pcb"
routed_path = work / "smoke_routed.kicad_pcb"

with KiCad(headless=True, timeout_ms=60_000) as kicad:
    print(f"KiCad {kicad.get_version().full_version}")
    kicad.create_document(str(schematic_path), DocumentType.DOCTYPE_SCHEMATIC)
    kicad.load_all_libraries()
    kicad.wait_for_libraries(timeout_s=300)
    sch = kicad.get_schematic()
    resistors = []
    for reference, x in (("R1", 101.6), ("R2", 127)):
        resistor = sch.place_symbol_from_library("Device:R", Vector2.from_xy_mm(x, 81.28), reference=reference)
        resistor.footprint_field.text.value = FOOTPRINT
        resistors.append(resistor)
    sch.update_items(resistors)
    items = []
    for resistor in resistors:
        for pin, net, step in (("1", "A", -2.54), ("2", "B", 2.54)):
            offset = next(p for p in resistor.definition.pins if p.number == pin).position
            wire = SchematicLine()
            wire.type = SchematicLineType.SLT_WIRE
            wire.start = resistor.position + offset
            wire.end = wire.start + Vector2.from_xy_mm(0, step)
            label = LocalLabel()
            label.text.value = net
            label.position = wire.end
            label.spin_style = SchematicLabelSpinStyle.SLSS_RIGHT
            items += [wire, label]
    sch.create_items(items)
    sch.save()
    sch.export_netlist(str(netlist_path))

    kicad.create_document(str(board_path), DocumentType.DOCTYPE_PCB)
    board = kicad.get_board()
    footprints = []
    # R2's rotation puts a rotate in its pose, which the router must read to find its pads.
    for reference, x, degrees in (("R1", 100, 0), ("R2", 110, 90)):
        footprint = board.place_footprint_from_library(FOOTPRINT, Vector2.from_xy_mm(x, 100))
        footprint.reference_field.text.value = reference
        footprint.orientation = Angle.from_degrees(degrees)
        footprints.append(footprint)
    board.update_items(footprints)
    result = board.import_netlist(str(netlist_path), match_mode=NetlistMatchMode.NMM_REFERENCE)
    if result.error_count:
        sys.exit(f"Netlist import failed:\n{result.report}")
    nets = sorted(p.net.name for f in board.get_footprints() for p in f.definition.pads)
    print(f"Pads on nets {nets}")
    if nets != ["/A", "/A", "/B", "/B"]:
        sys.exit("The netlist import did not assign the resistors' nets")
    board.save()

subprocess.run(
    [sys.executable, routing_tools / "py_router" / "route.py", board_path, routed_path, "--escalation", "off"],
    check=True,
    env={**os.environ, "KICAD_CLI": cli},
)

subprocess.run([cli, "sch", "erc", "--output", str(work / "erc.rpt"), str(schematic_path)], check=True)
drc_path = work / "drc.json"
subprocess.run([cli, "pcb", "drc", "--format", "json", "--output", str(drc_path), str(routed_path)], check=True)
drc = json.loads(drc_path.read_text())
problems = [
    item["description"]
    for item in drc["violations"] + drc["unconnected_items"]
    if item["type"]
    in (
        "clearance",
        "shorting_items",
        "tracks_crossing",
        "unconnected_items",
        "lib_footprint_mismatch",
    )
]
if problems:
    sys.exit(f"The routed board has {problems}")

subprocess.run(
    [sys.executable, Path(__file__).with_name("kicad-view.py"), routed_path, "--layers", "F.Cu,B.Cu,F.SilkS"]
    + ["--box", "95", "95", "20", "10", "--drc", drc_path, "-o", work / "view.png"],
    check=True,
    env={**os.environ, "KICAD_CLI": cli, "SPROCKET_KICAD_ROUTING_TOOLS": str(routing_tools)},
)

if FOOTPRINT not in board_path.read_text():
    sys.exit(f"The saved board does not contain {FOOTPRINT}")

shutil.rmtree(work)
print("Smoke test passed")
