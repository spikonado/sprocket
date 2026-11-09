#!/usr/bin/env bash
# Mirrors the desktop branch of scripts/run-dev.mjs, which forwards no flags to Electron,
# and adds the CDP port, an Xvfb display, the verify profiles and the xdg-open recorder.
source "$(dirname "$0")/common.sh"
load_dev_env

take_launch_lock
if port_busy "$cdp_port"; then
	echo "CDP port $cdp_port is taken. Set SPROCKET_VERIFY_CDP_PORT to a free port for launch, doctor, connect and stop." >&2
	exit 1
fi
if [[ -e "$server_link" && ! -L "$server_link" ]]; then
	echo "$server_link is a real build, and Electron would run it instead of the verify build. Move it aside first." >&2
	exit 1
fi
echo "Ports free. Launching." >&2
desktop_env

mkdir -p "$state_dir"
xvfb="$(nix build --no-link --print-out-paths nixpkgs#xorg.xorgserver)/bin/Xvfb"
openbox="$(nix build --no-link --print-out-paths nixpkgs#openbox)/bin/openbox"
"$xvfb" -displayfd 3 -screen 0 1440x900x24 -nolisten tcp 3>"$state_dir/display" 2>"$state_dir/xvfb.log" 9>&- &
echo $! >"$state_dir/Xvfb.pid"
trap 'kill $(cat "$state_dir/openbox.pid" "$state_dir/Xvfb.pid" 2>/dev/null) 2>/dev/null; rm -f "$state_dir"/{Xvfb,openbox}.pid "$state_dir/display"' EXIT
for _ in $(seq 50); do [[ -s "$state_dir/display" ]] && break; sleep 0.2; done
[[ -s "$state_dir/display" ]] || { echo "Xvfb did not start: $(cat "$state_dir/xvfb.log")" >&2; exit 1; }
# Without a window manager, close requests never reach Electron and windows stay blank in screen captures.
DISPLAY=":$(cat "$state_dir/display")" "$openbox" >"$state_dir/openbox.log" 2>&1 9>&- &
echo $! >"$state_dir/openbox.pid"
echo "Xvfb $(cat "$state_dir/Xvfb.pid") with openbox $(cat "$state_dir/openbox.pid") on :$(cat "$state_dir/display")" >&2

bun_install
cd "$repo_root"
# A cold build outlasts wait-for-api.mjs's 120 s limit. build.sh links a copy other worktrees' builds can't replace.
"$desktop_scripts/../../verify-sprocket-cli/scripts/build.sh" >/dev/null
mkdir -p "$(dirname "$server_link")"
ln -sfn "$worktree_bin" "$server_link"

web='bun run --cwd apps/web dev'
# convex dev refuses to push when the shared deployment holds data this worktree's schema rejects.
[[ "${SPROCKET_VERIFY_NO_PUSH:-}" == 1 ]] && web='bun run --cwd apps/web vite dev'
# Electron starts after Vite answers, so its 60 s renderer retry cannot run out while convex dev pushes.
nix develop -c bun x concurrently -k -n web,electron -c green,magenta "$web" \
	"until curl -fs -o /dev/null http://localhost:5173/; do sleep 1; done; $desktop_scripts/electron.sh --remote-debugging-port=$cdp_port"
