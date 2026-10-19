#!/usr/bin/env bash
# Read-only: is the running dev instance this worktree's, on the dev deployment, and serving?
set -uo pipefail

repo_root="$(git rev-parse --show-toplevel)"
main_checkout="$(git worktree list --porcelain | awk 'NR==1 {print $2}')"
env_file="${SPROCKET_VERIFY_ENV_FILE:-$repo_root/apps/web/.env.local}"
[[ -f "$env_file" ]] || env_file="$main_checkout/apps/web/.env.local"
dev_convex=$(grep '^VITE_CONVEX_URL=' "$env_file" 2>/dev/null | cut -d= -f2-)
status=0

fail() {
	echo "FAIL $*"
	status=1
}

if health=$(curl -fsS --max-time 3 http://127.0.0.1:7731/api/health); then
	echo "ok   API: $health"
else
	fail "API not answering on 127.0.0.1:7731"
fi

web_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:5173/)
[[ "$web_code" == 200 ]] && echo "ok   web: http://localhost:5173 -> 200" || fail "web: http://localhost:5173 -> $web_code"

api_pid=$(ss -Hltnp 'sport = :7731' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
if [[ -n "$api_pid" ]]; then
	api_env=$(tr '\0' '\n' <"/proc/$api_pid/environ")
	api_convex=$(grep '^PUBLIC_CONVEX_URL=' <<<"$api_env" | cut -d= -f2-)
	api_data=$(grep '^SPROCKET_DATA_DIR=' <<<"$api_env" | cut -d= -f2-)
	api_cwd=$(readlink "/proc/$api_pid/cwd")
	[[ -n "$dev_convex" && "$api_convex" == "$dev_convex" ]] && echo "ok   API Convex: $api_convex (dev)" ||
		fail "API Convex is '$api_convex', expected dev '$dev_convex'. Stop it; never drive it."
	[[ "$api_cwd" == "$repo_root" ]] && echo "ok   API worktree: $api_cwd" ||
		fail "API runs from $api_cwd, not this worktree ($repo_root). It is not serving your code."
	echo "info data dir: $api_data"
else
	fail "no process of yours listens on 7731"
fi

web_pid=$(ss -Hltnp 'sport = :5173' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
if [[ -n "$web_pid" ]]; then
	web_cwd=$(readlink "/proc/$web_pid/cwd")
	[[ "$web_cwd" == "$repo_root/apps/web" ]] && echo "ok   web worktree: $web_cwd" ||
		fail "Vite runs from $web_cwd, not $repo_root/apps/web"
fi

exit "$status"
