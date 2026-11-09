#!/usr/bin/env bash
# Rebuilds the vendored ecad-viewer bundle, the KiCad viewer from KiCAD-Prism.
# It publishes no package, so the web app ships this build of a pinned commit.
set -euo pipefail

commit=11f919e62af26daec974bec2b753443d75f659a1
# The KiCanvas commit the fork builds on; its license isn't in the fork's tree.
kicanvas_commit=b031159eb74aaa7eef2b026fd85d35bc05ff2095
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../apps/web/static/ecad-viewer"
src="$(mktemp -d)"
trap 'rm -rf "$src"' EXIT

git clone --quiet https://github.com/krishna-swaroop/ecad-viewer "$src"
git -C "$src" checkout --quiet "$commit"
# board-menu-reload: rebuilds the board's layer, object and net panels when the frame loads
# an edited board, so new layers get controls and can be picked, and nets stay current.
# bom-reload: redraws the BOM table when the frame loads edited files.
# bom-sourcing: adds the sourcing fields from the working-with-kicad skill, such as MPN and
# distributor part numbers, to the BOM, and keeps parts with different ones on separate rows.
# It also marks DNP parts and honors board-only BOMs' DNP and exclude-from-BOM flags.
# clear-selection: closes the property panels when the frame clears the selection on Escape.
# footprint-transform: KiCad 10.99 places footprints with
# `(transform (translate x y) (rotate r) (scale sx sy))` instead of `(at x y r)`.
# fresh-apps: builds new document apps when the set of documents changes, since moving
# the old ones into the new tabs breaks their nested elements.
# fresh-insets: redraws a schematic inset from the edited file instead of its cached scene.
# fullscreen-toggle: enters fullscreen on the first click after the user left it with Escape.
# hidden-tab-layout: lays out the board and schematic on hidden tabs, so their loads
# finish and schematic insets can draw a board that was never shown.
# load-settle: a failed load rejects only after its other files finish parsing, so none of
# them lands in the sources the frame restores next.
# parser-unclosed: fails on a file whose parentheses never close, such as one read
# mid-write, instead of loading an empty document.
# relative-sheets: loads sheets outside the opened file's folder, such as `../shared/x.kicad_sch`.
# reopen-sheet: reopens the sheet the user navigated to after the frame reloads edited files.
# sheet-instances: lists each instance of a reused sheet in the sheet panel and shows
# that instance's references, even when switching between instances of one file with the
# panel or the keyboard.
# show-tab: lets the frame open the other document after a cross-probe, and keeps
# the tab header in step when the viewer switches tabs itself.
# sprocket-theme: swaps hard-coded chrome colors for the theme variables the frame sets,
# and hides the Prism corner logo, which covers the BOM.
# worker-factory: lets the sandboxed frame start the parser workers from blob URLs.
git -C "$src" apply "$here"/*.patch
(cd "$src" && npm ci --silent)

rm -rf "$out"
node "$here/build.mjs" "$src" "$out"

# The minified bundles drop the license headers, so their texts are collected here.
notice() {
	printf '\n## %s\n\n```text\n' "$1"
	cat "$2"
	printf '```\n'
}
third_party="$src/packages/ecad-viewer-app/third_party"
curl -fsSL "https://raw.githubusercontent.com/theacodes/kicanvas/$kicanvas_commit/LICENSE.md" >"$src/KICANVAS_LICENSE.md"
{
	printf '# Licenses\n'
	notice "ecad-viewer (KiCAD-Prism fork of Huaqiu-Electronics/ecad-viewer)" "$src/LICENSE.md"
	notice "KiCanvas" "$src/KICANVAS_LICENSE.md"
	notice "earcut" "$third_party/earcut/LICENSE"
	notice "earcut.hpp" "$third_party/earcut-wasm/LICENSE"
	notice "Newstroke font" "$third_party/newstroke/THIRD_PARTY_README.md"
	notice "Comlink" "$src/node_modules/comlink/LICENSE"
	notice "Immutable" "$src/node_modules/immutable/LICENSE"
	notice "JSZip" "$src/node_modules/jszip/LICENSE.markdown"
} >"$out/LICENSE.md"
