#!/usr/bin/env bash
# Starts the desktop app on the instance's display with the verify env and profile. Extra arguments go to Electron.
source "$(dirname "$0")/common.sh"
load_dev_env
# desktop_env scrubs every SPROCKET_* variable, including this test override.
renderer_url="${SPROCKET_ELECTRON_RENDERER_URL:-}"
desktop_env
[[ -n "$renderer_url" ]] && export SPROCKET_ELECTRON_RENDERER_URL="$renderer_url"
export DISPLAY=":$(cat "$state_dir/display")"

cd "$repo_root"
exec nix develop -c node apps/desktop/launch.cjs --user-data-dir="$electron_profile" --disable-gpu "$@"
