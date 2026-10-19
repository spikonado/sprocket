#!/usr/bin/env bash
# Signs the verification profile's host in through a device code. Needs the API from launch.sh running.
# Prints the AuthKit URL and code, then blocks until the user approves (codes expire after about 5 minutes).
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
main_checkout="$(git worktree list --porcelain | awk 'NR==1 {print $2}')"
env_file="${SPROCKET_VERIFY_ENV_FILE:-$repo_root/apps/web/.env.local}"
[[ -f "$env_file" ]] || env_file="$main_checkout/apps/web/.env.local"

# Without these, the CLI falls back to the shell's or the compiled-in prod deployment.
export PUBLIC_CONVEX_URL="$(grep '^VITE_CONVEX_URL=' "$env_file" | cut -d= -f2-)"
export SPROCKET_DATA_DIR="${SPROCKET_VERIFY_DATA_DIR:-$HOME/.sprocket-dev-verify}"
export SPROCKET_PORT=7731

exec "${CARGO_TARGET_DIR:-$HOME/.cache/sprocket-verify-target}/debug/sprocket" login "$@"
