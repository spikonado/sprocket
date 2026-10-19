#!/usr/bin/env bash
# Starts `bun dev` for the current worktree against the dev Convex deployment.
# Runs in the foreground; start it as a background command session and stop it by terminating that session.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
main_checkout="$(git worktree list --porcelain | awk 'NR==1 {print $2}')"

env_file="${SPROCKET_VERIFY_ENV_FILE:-$repo_root/apps/web/.env.local}"
[[ -f "$env_file" ]] || env_file="$main_checkout/apps/web/.env.local"
if [[ ! -f "$env_file" ]]; then
	echo "No apps/web/.env.local in this worktree or $main_checkout. Ask the user for the dev Convex env file." >&2
	exit 1
fi
if ! grep -q '^VITE_CONVEX_URL=' "$env_file"; then
	echo "$env_file has no VITE_CONVEX_URL." >&2
	exit 1
fi

busy=$(ss -Hltn '( sport = :5173 or sport = :7731 )' | awk '$4 ~ /^(127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\[::\]|\*):/ {print $4}')
if [[ -n "$busy" ]]; then
	echo "Ports already in use: $busy. Another dev instance is running; run doctor.sh and do not start a second one." >&2
	exit 1
fi

data_dir="${SPROCKET_VERIFY_DATA_DIR:-$HOME/.sprocket-dev-verify}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/sprocket-verify-target}"
# The shell may export the prod deployment; run-dev.mjs derives the dev one from the env file.
unset PUBLIC_CONVEX_URL

if ts_host=$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null); then
	export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS="$ts_host"
fi

cd "$repo_root"
# A cold build outlasts wait-for-api.mjs's 120 s limit, which then kills the whole dev stack.
nix develop -c cargo build -p sprocket-cli
exec nix develop -c bun scripts/run-dev.mjs --env-file="$env_file" --data-dir="$data_dir"
