#!/usr/bin/env bash
# Stops what this worktree's CLI binary runs: hung clients, `serve`, temporary servers. Nothing else.
source "$(dirname "$0")/common.sh"

for pid in $(own_cli_pids); do
	echo "stopping $pid ($(pid_cmdline "$pid"))"
	kill "$pid" || true
done

for _ in 1 2 3 4 5 6 7 8 9 10; do
	[[ -z "$(own_cli_pids)" ]] && exit 0
	sleep 1
done
echo "still running: $(own_cli_pids)" >&2
exit 1
