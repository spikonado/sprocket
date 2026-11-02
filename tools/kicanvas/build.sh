#!/usr/bin/env bash
# Rebuilds the vendored KiCanvas bundle. KiCanvas publishes no package, so the
# web app ships this build of a pinned commit.
set -euo pipefail

commit=b031159eb74aaa7eef2b026fd85d35bc05ff2095
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../apps/web/static/kicanvas"
src="$(mktemp -d)"
trap 'rm -rf "$src"' EXIT

git clone --quiet https://github.com/theacodes/kicanvas "$src"
git -C "$src" checkout --quiet "$commit"
# parser-warnings: upstream stringifies the whole parent expression into each
# unknown-element warning, which turns an 85 MB board's parse from ~5 s into minutes.
# sheet-instances: upstream drops the sheet path, so every instance of a reused
# sheet shows the file's default references.
# page-visibility: an app that finishes loading after the user switches to a page
# in the other app shows itself anyway, so the board and schematic split the view.
git -C "$src" apply "$here"/*.patch
(cd "$src" && npm ci --silent && node scripts/build.js)

mkdir -p "$out"
cp "$src/build/kicanvas.js" "$out/kicanvas.js"
cp "$src/LICENSE.md" "$out/LICENSE.md"
