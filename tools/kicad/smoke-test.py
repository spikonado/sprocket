# Draws a one-resistor schematic through a headless kipy session, imports its netlist into a
# board, then runs ERC and DRC on the saved files.
# Usage: KICAD_CLI_PATH=<kicad-cli> python smoke-test.py <kicad template dir>
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from kipy import KiCad
from kipy.geometry import Vector2
from kipy.proto.board.board_commands_pb2 import NetlistMatchMode
from kipy.proto.common.types import DocumentType
from kipy.schematic_types import LocalLabel, SchematicLabelSpinStyle, SchematicLine, SchematicLineType

FOOTPRINT = "Resistor_SMD:R_0805_2012Metric"

cli = os.environ["KICAD_CLI_PATH"]
version = subprocess.run([cli, "version"], check=True, capture_output=True, text=True).stdout
major, minor = version.split(".")[:2]

template = Path(sys.argv[1])
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

with KiCad(headless=True, timeout_ms=60_000) as kicad:
    print(f"KiCad {kicad.get_version().full_version}")
    kicad.create_document(str(schematic_path), DocumentType.DOCTYPE_SCHEMATIC)
    kicad.load_all_libraries()
    kicad.wait_for_libraries(timeout_s=300)
    sch = kicad.get_schematic()
    r1 = sch.place_symbol_from_library("Device:R", Vector2.from_xy_mm(101.6, 81.28), reference="R1")
    r1.footprint_field.text.value = FOOTPRINT
    sch.update_items([r1])
    items = []
    for pin, net, step in (("1", "A", -2.54), ("2", "B", 2.54)):
        offset = next(p for p in r1.definition.pins if p.number == pin).position
        wire = SchematicLine()
        wire.type = SchematicLineType.SLT_WIRE
        wire.start = r1.position + offset
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
    footprint = board.place_footprint_from_library(FOOTPRINT, Vector2.from_xy_mm(100, 100))
    footprint.reference_field.text.value = "R1"
    board.update_items([footprint])
    result = board.import_netlist(str(netlist_path), match_mode=NetlistMatchMode.NMM_REFERENCE)
    if result.error_count:
        sys.exit(f"Netlist import failed:\n{result.report}")
    nets = sorted(p.net.name for f in board.get_footprints() for p in f.definition.pads)
    print(f"R1 pads on nets {nets}")
    if nets != ["/A", "/B"]:
        sys.exit("The netlist import did not assign R1's nets")
    board.save()

subprocess.run([cli, "sch", "erc", "--output", str(work / "erc.rpt"), str(schematic_path)], check=True)
subprocess.run([cli, "pcb", "drc", "--output", str(work / "drc.rpt"), str(board_path)], check=True)

if FOOTPRINT not in board_path.read_text():
    sys.exit(f"The saved board does not contain {FOOTPRINT}")

shutil.rmtree(work)
print("Smoke test passed")
