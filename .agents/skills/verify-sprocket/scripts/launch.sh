#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
load_dev_env

# Held by the exec'd dev stack until it exits, so agents queued behind one instance launch one at a time.
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/sprocket-verify-launch.lock"
if ! flock -n 9; then
	echo "Ports in use: another verify instance is running. Waiting for it to stop. If it is this worktree's leftover, run stop.sh." >&2
	flock 9
fi
busy=$(dev_port_listeners)
if [[ -n "$busy" ]]; then
	echo "Ports in use: $busy. Waiting for that instance to stop. If it is this worktree's leftover, run stop.sh." >&2
	while [[ -n "$(dev_port_listeners)" ]]; do sleep 30; done
fi
echo "Ports free. Launching." >&2

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
