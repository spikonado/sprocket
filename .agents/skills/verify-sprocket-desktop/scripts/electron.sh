#!/usr/bin/env bash
# Starts the desktop app on the instance's display with the verify env and profile. Extra arguments go to Electron.
source "$(dirname "$0")/common.sh"
load_dev_env
desktop_env
export DISPLAY=":$(cat "$state_dir/display")"

cd "$repo_root"
exec nix develop -c node apps/desktop/launch.cjs --user-data-dir="$electron_profile" --disable-gpu "$@"
