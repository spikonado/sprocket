#!/usr/bin/env bash
# Starts `bun dev` for this worktree against the dev Convex deployment, in the foreground.
source "$(dirname "$0")/common.sh"
load_dev_env

busy=$(dev_port_listeners)
if [[ -n "$busy" ]]; then
	echo "Ports already in use: $busy. Another dev instance is running. Run doctor.sh." >&2
	exit 1
fi

# The shell may export the prod deployment. run-dev.mjs derives the dev one from the env file.
unset PUBLIC_CONVEX_URL
if ts_host=$(tailnet_host 2>/dev/null); then
	export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS="$ts_host"
fi

cd "$repo_root"
# A new worktree, or a rebase that changed bun.lock, leaves node_modules missing packages Vite imports.
nix develop -c bun install --frozen-lockfile
# A cold build outlasts wait-for-api.mjs's 120 s limit, which then kills the whole dev stack.
nix develop -c cargo build -p sprocket-cli
exec nix develop -c bun scripts/run-dev.mjs --env-file="$env_file" --data-dir="$data_dir"
