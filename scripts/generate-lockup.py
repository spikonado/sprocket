# /// script
# requires-python = ">=3.12"
# dependencies = ["certifi==2026.10.23", "fonttools==4.63.0", "uharfbuzz==0.56.2"]
# ///
"""Writes a logo lockup SVG: the logo followed by a name set in Geist Serif as outlined paths.

Usage: uv run scripts/generate-lockup.py <logo.svg> <name> <out.svg>...
"""

import io
import re
import ssl
import sys
import urllib.request

import certifi
import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONT_URL = "https://raw.githubusercontent.com/vercel/geist-font/v1.9.2/fonts/GeistSerif/ttf/GeistSerif-Square.ttf"
LOGO_SIZE = 512
CAP_HEIGHT = LOGO_SIZE / 2
GAP = 0.22 * LOGO_SIZE


def number(value):
    return f"{value:.1f}".rstrip("0").rstrip(".")


def name_path(font_data, name):
    buffer = hb.Buffer()
    buffer.add_str(name)
    buffer.guess_segment_properties()
    hb.shape(hb.Font(hb.Face(font_data)), buffer, {"kern": True, "liga": True})

    font = TTFont(io.BytesIO(font_data))
    glyphs = font.getGlyphSet()
    glyph_order = font.getGlyphOrder()
    scale = CAP_HEIGHT / font["OS/2"].sCapHeight
    baseline = (LOGO_SIZE + CAP_HEIGHT) / 2

    path = SVGPathPen(glyphs, ntos=number)
    bounds = BoundsPen(glyphs)
    advance = 0
    for info, position in zip(buffer.glyph_infos, buffer.glyph_positions):
        x = LOGO_SIZE + GAP + (advance + position.x_offset) * scale
        y = baseline - position.y_offset * scale
        glyph = glyphs[glyph_order[info.codepoint]]
        glyph.draw(TransformPen(path, (scale, 0, 0, -scale, x, y)))
        glyph.draw(TransformPen(bounds, (scale, 0, 0, -scale, x, y)))
        advance += position.x_advance

    _, top, right, bottom = bounds.bounds
    if top < 0 or bottom > LOGO_SIZE:
        sys.exit(f"{name!r} doesn't fit in the logo's height")

    return path.getCommands(), round(right + 2)


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__.strip())

    logo_file, name, *outputs = sys.argv[1:]
    logo = re.search(r"<path[^>]*/>", open(logo_file).read()).group(0)
    tls = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(FONT_URL, context=tls) as response:
        path, width = name_path(response.read(), name)

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {LOGO_SIZE}">'
        f'{logo}<path fill="currentColor" d="{path}"/></svg>\n'
    )
    for output in outputs:
        with open(output, "w") as file:
            file.write(svg)


main()
