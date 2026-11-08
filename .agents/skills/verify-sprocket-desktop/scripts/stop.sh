#!/usr/bin/env bash
# Run after terminating the launch.sh session. Kills only this worktree's Electron, its server, Vite and the recorded Xvfb.
source "$(dirname "$0")/common.sh"
set +e
status=0

ours() {
	[[ "$(pid_cwd "$1")" == "$desktop_dir" ]]
}

# SIGTERM on Electron's main process stops the server it spawned before quitting.
for pid in $(port_pids "$cdp_port") $(port_pids 7731); do
	if ours "$pid"; then
		echo "stopping $pid ($(pid_cmdline "$pid" | cut -c1-120))"
		kill "$pid" 2>/dev/null
	else
		echo "leaving $pid: runs from $(pid_cwd "$pid")"
	fi
done
for _ in $(seq 20); do
	[[ -z "$(pgrep -u "$USER" -f "$electron_binary")" ]] && break
	sleep 0.5
done
for pid in $(pgrep -u "$USER" -f "$electron_binary"); do
	ours "$pid" && { echo "killing leftover Electron $pid"; kill -9 "$pid"; }
done

# Other agents run verify-sprocket from this worktree too. Its API on 7731 means the Vite on 5173 is theirs.
if [[ -z "$(port_pids 7731)" ]]; then
	"$web_scripts/stop.sh" || status=1
else
	echo "leaving 5173: 7731 belongs to $(port_pids 7731), another instance" >&2
fi

display=$(cat "$state_dir/display" 2>/dev/null)
for name in openbox Xvfb; do
	if pid=$(display_pid "$name"); then
		echo "stopping $name $pid on :$display"
		kill "$pid"
		sleep 1
	fi
done
# A killed Xvfb leaves its socket behind.
socket="/tmp/.X11-unix/X$display"
[[ -n "$display" && -S "$socket" && -O "$socket" ]] && ! display_pid Xvfb >/dev/null && rm -f "$socket"
rm -f "$state_dir"/{Xvfb,openbox}.pid "$state_dir/display"

if [[ -L "$server_link" ]]; then
	rm "$server_link"
	(cd "$repo_root" && rmdir -p --ignore-fail-on-non-empty target/debug)
fi

left=$(pgrep -u "$USER" -f "$electron_binary")
if [[ -n "$left" ]]; then
	echo "still running: $left" >&2
	status=1
fi
exit "$status"
