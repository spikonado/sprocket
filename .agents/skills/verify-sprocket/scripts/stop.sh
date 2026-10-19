#!/usr/bin/env bash
# Run after terminating the launch.sh session: `convex dev --start 'vite dev'` leaves Vite running under PID 1.
# Stops only dev-port listeners that run from this worktree.
source "$(dirname "$0")/common.sh"

for pid in $(dev_port_pids); do
	cwd=$(readlink "/proc/$pid/cwd" || true)
	if [[ "$cwd" == "$repo_root" || "$cwd" == "$repo_root/apps/web" ]]; then
		echo "stopping $pid ($(tr '\0' ' ' <"/proc/$pid/cmdline"))"
		kill "$pid"
	else
		echo "leaving $pid: runs from $cwd"
	fi
done

sleep 1
busy=$(dev_port_listeners)
if [[ -n "$busy" ]]; then
	echo "still listening: $busy" >&2
	exit 1
fi
