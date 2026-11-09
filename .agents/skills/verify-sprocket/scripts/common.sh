set -euo pipefail

repo_root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
worktree_id="$(printf %s "$repo_root" | cksum | cut -d' ' -f1)"
data_dir="${SPROCKET_VERIFY_DATA_DIR:-$HOME/.sprocket-dev-verify}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/sprocket-verify-target}"
launch_lock="${XDG_RUNTIME_DIR:-/tmp}/sprocket-verify-launch.lock"
dev_ports=(5173 7731)
# Each worktree keeps its own link, since every worktree's build replaces the shared debug/sprocket.
worktree_bin="$CARGO_TARGET_DIR/verify-cli/$worktree_id/sprocket"
# The committed root .env compiles prod in as the fallback deployment.
prod_convex_url="$(sed -n 's/^PUBLIC_CONVEX_URL=//p' "$repo_root/.env" | tr -d "\"'")"

load_dev_env() {
	local main_checkout
	main_checkout="$(git -C "$repo_root" worktree list --porcelain | sed -n '1s/^worktree //p')"
	env_file="$repo_root/apps/web/.env.local"
	[[ -f "$env_file" ]] || env_file="$main_checkout/apps/web/.env.local"
	if [[ ! -f "$env_file" ]]; then
		echo "No apps/web/.env.local in this worktree or $main_checkout. Ask the user for the dev Convex env file." >&2
		exit 1
	fi

	dev_convex_url="$(nix develop "$repo_root" -c bun "$repo_root/scripts/run-dev.mjs" --env-file="$env_file" --print-convex-url)"
	if [[ -z "$dev_convex_url" ]]; then
		echo "$env_file has no VITE_CONVEX_URL. Without it, the API falls back to the prod deployment." >&2
		exit 1
	fi
	if [[ "$dev_convex_url" == "$prod_convex_url" ]]; then
		echo "$env_file points VITE_CONVEX_URL at prod ($prod_convex_url). Ask the user for the dev env file." >&2
		exit 1
	fi
}

port_filter() {
	local port filter=
	for port in "$@"; do filter+="${filter:+ or }sport = :$port"; done
	echo "( $filter )"
}

# ss shows PIDs only for this user's processes.
port_pids() {
	ss -Hltnp "$(port_filter "$@")" | { grep -o 'pid=[0-9]*' || true; } | cut -d= -f2 | sort -u
}

port_local_listeners() {
	ss -Hltn "$(port_filter "$@")" | awk '$4 ~ /^(127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\[::\]|\*):/ {print $4}'
}

port_busy() {
	[[ -n "$(ss -Hltn "$(port_filter "$@")")" ]]
}

pid_cwd() {
	readlink "/proc/$1/cwd" 2>/dev/null || true
}

pid_cmdline() {
	tr '\0' ' ' 2>/dev/null <"/proc/$1/cmdline" || true
}

# Usage: pid_env <pid> <NAME>
pid_env() {
	tr '\0' '\n' <"/proc/$1/environ" | sed -n "s/^$2=//p"
}

# Usage: take_port_lock <lock file> <port ...>
# Holds fd 9 until the exec'd server exits, so agents queued behind one instance launch one at a time.
take_port_lock() {
	exec 9>"$1"
	shift
	if ! flock -n 9; then
		echo "Ports in use: another verify instance is running. Waiting for it to stop. If it is this worktree's leftover, run stop.sh." >&2
		flock 9
	fi
	local busy
	busy=$(port_local_listeners "$@")
	if [[ -n "$busy" ]]; then
		echo "Ports in use: $busy. Waiting for that instance to stop. If it is this worktree's leftover, run stop.sh." >&2
		while [[ -n "$(port_local_listeners "$@")" ]]; do sleep 30; done
	fi
}

take_launch_lock() { take_port_lock "$launch_lock" "${dev_ports[@]}"; }

# Usage: stop_listeners <own dir>[:<own dir>...] <port ...>
# Kills the listeners that run from one of the own dirs, then fails while any port still listens.
stop_listeners() {
	local own_dirs=$1 pid cwd busy
	shift
	for pid in $(port_pids "$@"); do
		cwd=$(pid_cwd "$pid")
		if [[ ":$own_dirs:" == *":$cwd:"* ]]; then
			echo "stopping $pid ($(pid_cmdline "$pid"))"
			kill "$pid"
		else
			echo "leaving $pid: runs from $cwd"
		fi
	done

	sleep 1
	busy=$(port_local_listeners "$@")
	if [[ -n "$busy" ]]; then
		echo "still listening: $busy" >&2
		return 1
	fi
}

# Agent shells inherit the installed app's SPROCKET_* variables. A dev server that keeps them can run the user's
# update script, delete the installed launcher's restart file, serve its web bundle and use its git tokens.
scrub_installed_app_env() {
	local name
	# Not compgen: nix develop's non-interactive bash lacks it.
	for name in "${!SPROCKET_@}"; do
		[[ "$name" != SPROCKET_VERIFY_* ]] && unset "$name"
	done
	export PUBLIC_POSTHOG_KEY=
}

# Several verify skills install into the same worktree, and concurrent installs corrupt node_modules.
bun_install() {
	(
		flock 8
		cd "$repo_root"
		nix develop -c bun install --frozen-lockfile
	) 8>"/tmp/sprocket-bun-install-$worktree_id.lock"
}

tailnet_host() {
	tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'
}

allow_tailnet_host() {
	local host
	if host=$(tailnet_host 2>/dev/null); then
		export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS="$host"
	fi
}

# For doctor.sh scripts, which run with set +e and exit with $status.
status=0
check() {
	if [[ "$1" == ok ]]; then echo "ok   $2"; else echo "FAIL $2"; status=1; fi
}

check_api_convex() {
	local convex
	convex=$(pid_env "$1" PUBLIC_CONVEX_URL)
	[[ "$convex" == "$dev_convex_url" ]] && check ok "API Convex: $convex (dev)" ||
		check fail "API Convex is '$convex', expected '$dev_convex_url'. Stop it now."
}

check_dev_http() {
	local health web_code
	health=$(curl -fs --max-time 3 http://127.0.0.1:7731/api/health)
	[[ -n "$health" ]] && check ok "API: $health" || check fail "API not answering on 127.0.0.1:7731"
	web_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:5173/)
	[[ "$web_code" == 200 ]] && check ok "web: http://localhost:5173 -> 200" || check fail "web: http://localhost:5173 -> $web_code"
}
