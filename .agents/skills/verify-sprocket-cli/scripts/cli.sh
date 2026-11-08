#!/usr/bin/env bash
# Usage: cli.sh [NAME=value ...] [sprocket args ...]
source "$(dirname "$0")/common.sh"

if [[ ! -x "$cli_bin" ]]; then
	echo "No CLI build for this worktree. Run build.sh first." >&2
	exit 1
fi

overrides=()
while [[ $# -gt 0 && "$1" =~ ^[A-Z_][A-Z0-9_]*= ]]; do
	overrides+=("$1")
	shift
done

case "${1:-}" in
--help | -h | --version | -V | help | update | upgrade) needs_server= ;;
*) needs_server=1 ;;
esac

if [[ -n "$needs_server" ]]; then
	# fd 9 stays open in sprocket and in the temporary server it spawns, so the lock lasts until both exit.
	exec 9>"$launch_lock"
	if ! flock -n 9; then
		if pid=$(own_api_pid); then
			echo "Sharing the lock with this worktree's server, PID $pid." >&2
			exec 9>&-
		else
			echo "Lock held: another verify instance owns port $cli_port and $data_dir. Waiting for it to stop." >&2
			flock 9
		fi
	fi
	while port_busy "$cli_port" && ! own_api_pid >/dev/null; do
		echo "Port $cli_port is still in use. Waiting." >&2
		sleep 2
	done
fi

scrub_installed_app_env
mkdir -p "$evidence_root"
exec env \
	PATH="$cli_scripts/stubs:$PATH" \
	PUBLIC_CONVEX_URL="$dev_convex_url" \
	SPROCKET_DATA_DIR="$data_dir" \
	SPROCKET_PORT="$cli_port" \
	VERIFY_CLI_OPENED="${VERIFY_CLI_OPENED:-$evidence_root/opened.log}" \
	"${overrides[@]}" \
	"$cli_bin" "$@"
