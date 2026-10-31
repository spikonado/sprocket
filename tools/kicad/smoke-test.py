# Places a library footprint through a headless kipy session, then runs DRC on the saved board.
# Usage: KICAD_CLI_PATH=<kicad-cli> python smoke-test.py <kicad template dir>
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from kipy import KiCad
from kipy.geometry import Vector2
from kipy.proto.common.types import DocumentType

FOOTPRINT = "Resistor_SMD:R_0805_2012Metric"

template = Path(sys.argv[1])
work = Path(tempfile.mkdtemp())
config = work / "config"
version_config = config / "10.99"
version_config.mkdir(parents=True)
for table in ("fp-lib-table", "sym-lib-table"):
    shutil.copy(template / table, version_config / table)
os.environ["KICAD_CONFIG_HOME"] = str(config)

board_path = work / "smoke.kicad_pcb"

with KiCad(headless=True, timeout_ms=60_000) as kicad:
    print(f"KiCad {kicad.get_version().full_version}")
    kicad.create_document(str(board_path), DocumentType.DOCTYPE_PCB)
    board = kicad.get_board()
    kicad.load_all_libraries()
    kicad.wait_for_libraries(timeout_s=300)
    footprint = board.place_footprint_from_library(FOOTPRINT, Vector2.from_xy_mm(100, 100))
    print(f"Placed {FOOTPRINT} with {len(footprint.definition.pads)} pads")
    board.save()

report = work / "drc.json"
subprocess.run(
    [
        os.environ["KICAD_CLI_PATH"],
        "pcb",
        "drc",
        "--format",
        "json",
        "--output",
        str(report),
        str(board_path),
    ],
    check=True,
)
print(f"DRC report: {report.stat().st_size} bytes")

if FOOTPRINT not in board_path.read_text():
    sys.exit(f"The saved board does not contain {FOOTPRINT}")

shutil.rmtree(work)
