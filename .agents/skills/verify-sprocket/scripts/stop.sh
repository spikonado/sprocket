#!/usr/bin/env bash
# Run after terminating the launch.sh session. `convex dev --start 'vite dev'` leaves Vite running under PID 1,
# so this stops any listener on 5173/7731 that runs from this worktree, and nothing else.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"

for pid in $(ss -Hltnp '( sport = :5173 or sport = :7731 )' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
	cwd=$(readlink "/proc/$pid/cwd" || true)
	if [[ "$cwd" == "$repo_root" || "$cwd" == "$repo_root"/* ]]; then
		echo "stopping $pid ($(tr '\0' ' ' <"/proc/$pid/cmdline"))"
		kill "$pid"
	else
		echo "leaving $pid: runs from $cwd, not this worktree"
	fi
done

sleep 1
ss -Hltn '( sport = :5173 or sport = :7731 )' | awk '$4 ~ /^(127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\[::\]|\*):/ {found=1; print "still listening: " $4} END {exit found}'
