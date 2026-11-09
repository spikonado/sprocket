#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
load_dev_env
take_launch_lock
echo "Ports free. Launching." >&2

# The shell may export the prod deployment. run-dev.mjs derives the dev one from the env file.
unset PUBLIC_CONVEX_URL
scrub_installed_app_env
allow_tailnet_host

# A new worktree, or a rebase that changed bun.lock, leaves node_modules missing packages Vite imports.
bun_install
cd "$repo_root"
# A cold build outlasts wait-for-api.mjs's 120 s limit, which then kills the whole dev stack.
nix develop -c cargo build -p sprocket-cli
exec nix develop -c bun scripts/run-dev.mjs --env-file="$env_file" --data-dir="$data_dir"
