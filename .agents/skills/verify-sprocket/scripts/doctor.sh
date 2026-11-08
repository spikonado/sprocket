#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
load_dev_env
set +e

check_dev_http

api_seen=
for pid in $(port_pids "${dev_ports[@]}"); do
	cwd=$(pid_cwd "$pid")
	if [[ "$cwd" == "$repo_root/apps/web" ]]; then
		check ok "Vite runs from $cwd"
	elif [[ "$cwd" == "$repo_root" ]]; then
		api_seen=1
		check_api_convex "$pid"
	else
		check fail "PID $pid on a dev port runs from $cwd, not this worktree"
	fi
done
[[ -n "$api_seen" ]] || check fail "no API process from this worktree"

exit "$status"
