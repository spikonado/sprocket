#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
load_dev_env

# With no server on 7731 the CLI spawns a temporary one outside the launch lock.
api_ours=
for pid in $(port_pids 7731); do
	[[ "$(pid_cwd "$pid")" == "$repo_root" ]] && api_ours=1
done
if [[ -z "$api_ours" ]]; then
	echo "No API from this worktree on 7731. Run launch.sh first." >&2
	exit 1
fi

scrub_installed_app_env
# Without these, the CLI uses the shell's or the compiled-in prod deployment.
export PUBLIC_CONVEX_URL="$dev_convex_url" SPROCKET_DATA_DIR="$data_dir" SPROCKET_PORT=7731
exec "$CARGO_TARGET_DIR/debug/sprocket" login "$@"
