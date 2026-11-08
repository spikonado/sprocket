cli_scripts="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$cli_scripts/../../verify-sprocket/scripts/common.sh"
load_dev_env

evidence_root=/tmp/verify-sprocket-cli
cli_port=7731
# Every worktree's build relinks the shared $CARGO_TARGET_DIR/debug/sprocket, so each worktree keeps its own link.
cli_bin="$worktree_bin"

# This worktree's `serve`, or with VERIFY_CLI_USE_WEB=1 its verify-sprocket API.
# Temporary servers don't count: they exit within a second of going idle.
own_api_pid() {
	local pid exe cwd
	for pid in $(port_pids "$cli_port"); do
		exe=$(readlink "/proc/$pid/exe" || true)
		cwd=$(pid_cwd "$pid")
		if [[ "$exe" == "$cli_bin"* ]] && ! pid_cmdline "$pid" | grep -q -- --cli-temporary; then
			echo "$pid"
			return 0
		fi
		if [[ "${VERIFY_CLI_USE_WEB:-}" == 1 && "$exe" != "$cli_bin"* && "$cwd" == "$repo_root" ]]; then
			echo "$pid"
			return 0
		fi
	done
	return 1
}

# Processes running this worktree's CLI binary: clients, `serve`, and the temporary servers they spawn.
own_cli_pids() {
	local exe
	for exe in /proc/[0-9]*/exe; do
		[[ "$(readlink "$exe" 2>/dev/null)" == "$cli_bin"* ]] && basename "$(dirname "$exe")"
	done
	return 0
}
