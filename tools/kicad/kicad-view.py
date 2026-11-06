"""Renders one area of a KiCad board as a PNG, with net names on pads and tracks and DRC markers.

Copper comes from KiCadRoutingTools' renderer; other layers come from KiCad's DXF export.
"""

import argparse
import fnmatch
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(os.environ["SPROCKET_KICAD_ROUTING_TOOLS"]) / "py_router"))

from kicad_parser import parse_kicad_pcb  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402
from route_render import BoardRenderer, load_font, mm_ruler_overlay  # noqa: E402

GRAPHIC_COLORS = [(40, 40, 40), (120, 40, 170), (0, 120, 130), (170, 90, 0), (90, 90, 160)]
DRC_COLORS = {"error": (230, 0, 0), "warning": (240, 140, 0)}
CHOSEN_PAD = (235, 120, 0)
REFERENCE = (255, 235, 130)
CONTEXT_ALPHA = 45
MIN_FONT_PX = 9
DRC_UNITS_MM = {"mm": 1.0, "in": 25.4, "mils": 0.0254}


def parse_args():
    parser = argparse.ArgumentParser(prog="kicad-view", description=__doc__.split("\n")[0])
    parser.add_argument("board")
    parser.add_argument("-o", "--output", required=True, help="PNG to write")
    parser.add_argument("--box", nargs=4, type=float, metavar=("X", "Y", "W", "H"), help="area in mm")
    parser.add_argument("--layers", help="comma-separated layers, such as F.Cu,In1.Cu,F.SilkS,F.Fab (default: all copper)")
    parser.add_argument("--nets", nargs="+", metavar="PATTERN", help="highlight and name only these nets (fnmatch on the full or short name)")
    parser.add_argument("--drc", help="JSON report from kicad-cli pcb drc --format json")
    parser.add_argument("--size", type=int, default=1600, help="longest image side in px (default 1600)")
    return parser.parse_args()


def main():
    args = parse_args()
    pcb = parse_kicad_pcb(args.board)
    layers = args.layers.split(",") if args.layers else list(pcb.board_info.copper_layers)
    copper = [layer for layer in layers if layer in pcb.board_info.copper_layers]
    graphics = [layer for layer in layers if layer not in copper]
    chosen = chosen_nets(pcb, args.nets) if args.nets else None

    view = None
    if args.box:
        x, y, w, h = args.box
        view = (x, y, x + w, y + h)
    renderer = BoardRenderer(pcb, size=args.size, layers=copper or None, view=view, show_pads=bool(copper), show_zones=bool(copper))
    if view:
        scale = args.size / max(view[2] - view[0], view[3] - view[1])
        renderer.set_canvas(round((view[2] - view[0]) * scale), round((view[3] - view[1]) * scale))

    segments = [s for s in pcb.segments if s.layer in copper]
    vias = pcb.vias if copper else []
    overlays = [mm_ruler_overlay()]
    graphic_colors = {}
    if graphics:
        overlays.insert(0, graphics_overlay(export_dxf(args.board, graphics), graphic_colors))
    if chosen is not None:
        renderer.layer_alpha = CONTEXT_ALPHA
        overlays.insert(0, chosen_overlay(pcb, chosen, segments))
    image = renderer.frame(segments=segments, vias=vias, overlays=overlays)

    to_px = lambda x, y: tuple(v / renderer.ss for v in renderer.tf.pt(x, y))  # noqa: E731
    px_per_mm = renderer.tf.length(1.0) / renderer.ss
    labels = Labels(image)
    if args.drc:
        draw_drc(image, labels, to_px, load_drc(args.drc))
    for reference, footprint in pcb.footprints.items():
        x, y = to_px(footprint.x, footprint.y)
        if labels.inside(x, y):
            labels.place(x, y, reference, 13, fill=REFERENCE)
    label_pads(labels, to_px, px_per_mm, pcb, chosen)
    label_tracks(labels, to_px, px_per_mm, pcb, segments, chosen)
    draw_legend(image, [(layer, renderer.palette[layer]) for layer in copper] + list(graphic_colors.items()))
    image.save(args.output)
    print(f"kicad-view: wrote {args.output} ({image.width}x{image.height}, {px_per_mm:.1f} px/mm)")


def chosen_nets(pcb, patterns):
    names = {net.name for net in pcb.nets.values() if net.name}
    matches = lambda name, p: fnmatch.fnmatchcase(name, p) or fnmatch.fnmatchcase(short(name), p)  # noqa: E731
    unmatched = [p for p in patterns if not any(matches(name, p) for name in names)]
    if unmatched:
        sys.exit(f"kicad-view: no net matches {', '.join(unmatched)}")
    return {name for name in names if any(matches(name, p) for p in patterns)}


def short(name):
    """The net name without its sheet path, as KiCad shows it on pads and tracks."""
    return name.rsplit("/", 1)[-1]


def chosen_overlay(pcb, chosen, segments):
    ids = {net_id for net_id, net in pcb.nets.items() if net.name in chosen}

    def draw(d, renderer):
        renderer.draw_pads(
            d,
            [pad for fp in pcb.footprints.values() for pad in fp.pads if pad.net_id in ids],
            fill_for=lambda _: CHOSEN_PAD,
        )
        renderer._draw_segments(d, [s for s in segments if s.net_id in ids])
        renderer._draw_vias(d, [v for v in pcb.vias if v.net_id in ids], color=(30, 30, 30))

    return draw


def export_dxf(board, layers):
    with tempfile.TemporaryDirectory() as directory:
        dxf = Path(directory) / "layers.dxf"
        subprocess.run(
            [os.environ["KICAD_CLI"], "pcb", "export", "dxf", "--mode-single", "--ou", "mm", "-l", ",".join(layers), "-o", str(dxf), board],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        lines = dxf.read_text().splitlines()
    pairs = zip(lines[0::2], lines[1::2])
    entities, entity, in_entities = [], None, False
    for code, value in ((int(c), v.strip()) for c, v in pairs):
        if code == 2 and value == "ENTITIES":
            in_entities = True
        elif not in_entities:
            continue
        elif code == 0:
            if value == "ENDSEC":
                break
            entity = {"type": value, "points": []}
            entities.append(entity)
        elif entity is None:
            continue
        elif code == 8:
            entity["layer"] = value
        elif code in (10, 11):
            entity["points"].append([float(value), 0.0])
        elif code in (20, 21):
            entity["points"][-1][1] = -float(value)
        elif code in (40, 50, 51, 70):
            entity[code] = float(value)
    return [e for e in entities if e.get("layer") and e["points"]]


def graphics_overlay(entities, colors):
    def draw(d, renderer):
        width = max(renderer.ss, round(renderer.tf.length(0.08)))
        for entity in entities:
            color = colors.setdefault(entity["layer"], GRAPHIC_COLORS[len(colors) % len(GRAPHIC_COLORS)])
            points = [renderer.tf.pt(x, y) for x, y in entity["points"]]
            if entity["type"] in ("LINE", "LWPOLYLINE"):
                if entity["type"] == "LWPOLYLINE" and int(entity.get(70, 0)) & 1:
                    points.append(points[0])
                d.line(points, fill=color, width=width)
            elif entity["type"] in ("CIRCLE", "ARC"):
                (cx, cy), r = points[0], renderer.tf.length(entity[40])
                box = [cx - r, cy - r, cx + r, cy + r]
                if entity["type"] == "CIRCLE":
                    d.ellipse(box, outline=color, width=width)
                else:
                    # DXF is y-up, so flipping y reverses the sweep.
                    d.arc(box, -entity[51], -entity[50], fill=color, width=width)

    return draw


def load_drc(path):
    report = json.loads(Path(path).read_text())
    scale = DRC_UNITS_MM.get(report.get("coordinate_units", "mm"), 1.0)
    markers = []
    for kind in ("violations", "unconnected_items"):
        for violation in report.get(kind, []):
            points = [(item["pos"]["x"] * scale, item["pos"]["y"] * scale) for item in violation.get("items", []) if "pos" in item]
            if points:
                markers.append((violation, points, kind == "unconnected_items"))
    return markers


def draw_drc(image, labels, to_px, markers):
    d = ImageDraw.Draw(image)
    shown = 0
    for violation, points, unconnected in markers:
        pixels = [to_px(x, y) for x, y in points]
        visible = [(x, y) for x, y in pixels if labels.inside(x, y)]
        if not visible:
            continue
        shown += 1
        color = DRC_COLORS.get(violation.get("severity"), DRC_COLORS["error"])
        if unconnected:
            d.line(pixels, fill=color, width=2)
        for x, y in visible:
            d.ellipse([x - 9, y - 9, x + 9, y + 9], outline=color, width=3)
            d.line([x - 6, y - 6, x + 6, y + 6], fill=color, width=2)
            d.line([x - 6, y + 6, x + 6, y - 6], fill=color, width=2)
        labels.place(visible[0][0] + 12, visible[0][1] - 12, violation["type"], 13, fill=color, center=False)
        where = ", ".join(f"({x:g}, {y:g})" for x, y in points)
        print(f"{violation.get('severity', '')} {violation['type']} at {where}: {violation.get('description', '')}")
        for item in violation.get("items", []):
            print(f"  {item.get('description', '')}")
    print(f"kicad-view: {shown} DRC markers in view")


def label_pads(labels, to_px, px_per_mm, pcb, chosen):
    for footprint in pcb.footprints.values():
        for pad in footprint.pads:
            if not pad.net_name or (chosen is not None and pad.net_name not in chosen):
                continue
            x, y = to_px(pad.global_x, pad.global_y)
            if not labels.inside(x, y):
                continue
            width, height = pad.size_x * px_per_mm, pad.size_y * px_per_mm
            angle = 90 if height > width * 1.2 else 0
            long_side, short_side = max(width, height), min(width, height)
            text = short(pad.net_name)
            size = labels.fitting_size(text, long_side * 0.9, short_side * 0.7)
            if size >= MIN_FONT_PX:
                labels.place(x, y, text, size, angle=angle)


def label_tracks(labels, to_px, px_per_mm, pcb, segments, chosen):
    spacing = 250
    named = {}
    for segment in sorted(segments, key=lambda s: -math.dist((s.start_x, s.start_y), (s.end_x, s.end_y))):
        net = pcb.nets.get(segment.net_id)
        if not net or not net.name or (chosen is not None and net.name not in chosen):
            continue
        visible = labels.clip(to_px(segment.start_x, segment.start_y), to_px(segment.end_x, segment.end_y))
        if not visible:
            continue
        (x0, y0), (x1, y1) = visible
        x, y = (x0 + x1) / 2, (y0 + y1) / 2
        if any(math.dist((x, y), p) < spacing for p in named.get(net.name, ())):
            continue
        size = min(16, max(MIN_FONT_PX, round(segment.width * px_per_mm)))
        text = short(net.name)
        if math.dist((x0, y0), (x1, y1)) < labels.text_width(text, size) + 10:
            continue
        angle = -math.degrees(math.atan2(y1 - y0, x1 - x0))
        angle = (angle + 90) % 180 - 90
        if labels.place(x, y, text, size, angle=angle):
            named.setdefault(net.name, []).append((x, y))


class Labels:
    """Draws text with an outline and skips any label that would overlap an earlier one."""

    def __init__(self, image):
        self.image = image
        self.taken = []

    def inside(self, x, y):
        return 0 <= x < self.image.width and 0 <= y < self.image.height

    def text_width(self, text, size):
        left, _, right, _ = load_font(size).getbbox(text, stroke_width=2)
        return right - left

    def fitting_size(self, text, width, height):
        return min(28, int(height), int(20 * width / max(1, self.text_width(text, 20))))

    def clip(self, start, end):
        """The part of the line from `start` to `end` inside the image, or None."""
        (x0, y0), (x1, y1) = start, end
        t0, t1 = 0.0, 1.0
        for p, q in ((-(x1 - x0), x0), (x1 - x0, self.image.width - x0), (-(y1 - y0), y0), (y1 - y0, self.image.height - y0)):
            if p == 0:
                if q < 0:
                    return None
                continue
            t = q / p
            if p < 0:
                t0 = max(t0, t)
            else:
                t1 = min(t1, t)
        if t0 >= t1:
            return None
        return [(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t) for t in (t0, t1)]

    def place(self, x, y, text, size, angle=0, fill=(255, 255, 255), center=True):
        font = load_font(size)
        left, top, right, bottom = font.getbbox(text, stroke_width=2)
        tile = Image.new("RGBA", (right - left, bottom - top))
        ImageDraw.Draw(tile).text((-left, -top), text, font=font, fill=fill, stroke_width=2, stroke_fill=(0, 0, 0))
        if angle:
            tile = tile.rotate(angle, expand=True, resample=Image.BICUBIC)
        if center:
            x, y = x - tile.width / 2, y - tile.height / 2
        box = (x, y, x + tile.width, y + tile.height)
        if any(box[0] < b[2] and b[0] < box[2] and box[1] < b[3] and b[1] < box[3] for b in self.taken):
            return False
        self.taken.append(box)
        self.image.paste(tile, (round(x), round(y)), tile)
        return True


def draw_legend(image, entries):
    d = ImageDraw.Draw(image)
    font = load_font(13)
    x, y = 8, image.height - 24
    for name, color in entries:
        width = d.textlength(name, font=font)
        d.rectangle([x - 4, y - 4, x + width + 24, y + 18], fill=(255, 255, 255))
        d.rectangle([x, y + 1, x + 14, y + 13], fill=color)
        d.text((x + 18, y), name, fill=(0, 0, 0), font=font)
        x += width + 32


if __name__ == "__main__":
    main()
