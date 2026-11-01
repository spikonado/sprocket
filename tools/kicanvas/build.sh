#!/usr/bin/env bash
# Rebuilds the vendored KiCanvas bundle. KiCanvas publishes no package, so the
# web app ships this build of a pinned commit.
set -euo pipefail

commit=b031159eb74aaa7eef2b026fd85d35bc05ff2095
out="$(cd "$(dirname "$0")/../.." && pwd)/apps/web/static/kicanvas"
src="$(mktemp -d)"
trap 'rm -rf "$src"' EXIT

git clone --quiet https://github.com/theacodes/kicanvas "$src"
git -C "$src" checkout --quiet "$commit"
(cd "$src" && npm ci --silent && node scripts/build.js)

mkdir -p "$out"
cp "$src/build/kicanvas.js" "$out/kicanvas.js"
cp "$src/LICENSE.md" "$out/LICENSE.md"
