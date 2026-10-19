#!/usr/bin/env bash
# Read-only: is the running dev instance this worktree's, on the dev deployment, and serving?
source "$(dirname "$0")/common.sh"
load_dev_env
set +e
status=0

check() {
	if [[ "$1" == ok ]]; then echo "ok   $2"; else echo "FAIL $2"; status=1; fi
}

health=$(curl -fs --max-time 3 http://127.0.0.1:7731/api/health)
[[ -n "$health" ]] && check ok "API: $health" || check fail "API not answering on 127.0.0.1:7731"

web_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:5173/)
[[ "$web_code" == 200 ]] && check ok "web: http://localhost:5173 -> 200" || check fail "web: http://localhost:5173 -> $web_code"

api_seen=
for pid in $(dev_port_pids); do
	cwd=$(readlink "/proc/$pid/cwd")
	if [[ "$cwd" == "$repo_root/apps/web" ]]; then
		check ok "Vite runs from $cwd"
	elif [[ "$cwd" == "$repo_root" ]]; then
		api_seen=1
		convex=$(tr '\0' '\n' <"/proc/$pid/environ" | sed -n 's/^PUBLIC_CONVEX_URL=//p')
		[[ "$convex" == "$dev_convex_url" ]] && check ok "API Convex: $convex (dev)" ||
			check fail "API Convex is '$convex', expected '$dev_convex_url'. Stop it now."
	else
		check fail "PID $pid on a dev port runs from $cwd, not this worktree"
	fi
done
[[ -n "$api_seen" ]] || check fail "no API process from this worktree"

exit "$status"
