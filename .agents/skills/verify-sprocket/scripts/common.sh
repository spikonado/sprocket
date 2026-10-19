# Sourced by the other helpers. Sets repo_root, env_file, dev_convex_url, data_dir and CARGO_TARGET_DIR.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
main_checkout="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"

env_file="${SPROCKET_VERIFY_ENV_FILE:-$repo_root/apps/web/.env.local}"
[[ -f "$env_file" ]] || env_file="$main_checkout/apps/web/.env.local"
if [[ ! -f "$env_file" ]]; then
	echo "No apps/web/.env.local in this worktree or $main_checkout. Ask the user for the dev Convex env file." >&2
	exit 1
fi

# Same parser as scripts/run-dev.mjs, so quoting is handled identically.
dev_convex_url="$(node -e 'const fs = require("node:fs"); const { parseEnv } = require("node:util"); process.stdout.write(parseEnv(fs.readFileSync(process.argv[1], "utf8")).VITE_CONVEX_URL ?? "")' "$env_file")"
if [[ -z "$dev_convex_url" ]]; then
	echo "$env_file has no VITE_CONVEX_URL; without it the API falls back to the prod deployment." >&2
	exit 1
fi

data_dir="${SPROCKET_VERIFY_DATA_DIR:-$HOME/.sprocket-dev-verify}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/sprocket-verify-target}"

# Prints the PIDs of dev-port listeners this user can see.
dev_port_pids() {
	ss -Hltnp '( sport = :5173 or sport = :7731 )' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
}

# Prints dev-port listen addresses, skipping tailscale serve on the tailnet IP.
dev_port_listeners() {
	ss -Hltn '( sport = :5173 or sport = :7731 )' | awk '$4 ~ /^(127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\[::\]|\*):/ {print $4}'
}
