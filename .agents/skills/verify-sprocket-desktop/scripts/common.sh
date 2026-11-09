desktop_scripts="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
web_scripts="$desktop_scripts/../../verify-sprocket/scripts"
source "$web_scripts/common.sh"

desktop_dir="$repo_root/apps/desktop"
electron_binary="$desktop_dir/node_modules/electron/dist/electron"
cdp_port="${SPROCKET_VERIFY_CDP_PORT:-9393}"
electron_profile="${SPROCKET_VERIFY_ELECTRON_PROFILE:-$HOME/.sprocket-dev-verify-desktop}"
evidence_root=/tmp/verify-sprocket-desktop
state_dir="$evidence_root/instance-$worktree_id"
opened_urls="$evidence_root/opened-urls.log"
# In dev, main.mjs runs the server from here and ignores CARGO_TARGET_DIR.
server_link="$repo_root/target/debug/sprocket"

# Prints the live PID that launch.sh recorded for $1 (Xvfb or openbox).
display_pid() {
	local pid
	pid=$(cat "$state_dir/$1.pid" 2>/dev/null) || return 1
	[[ "$(pid_cmdline "$pid")" == *"$1"* ]] && echo "$pid"
}

# Run a command against the instance's Xvfb display.
on_display() {
	DISPLAY=":$(cat "$state_dir/display")" "$@"
}

# The env run-dev.mjs --desktop gives its children, for the verify profile on X11. Call after load_dev_env.
desktop_env() {
	scrub_installed_app_env
	unset WAYLAND_DISPLAY
	local entry
	while IFS= read -r -d '' entry; do
		export "$entry"
	done < <(nix develop "$repo_root" -c node -e 'const fs = require("node:fs"); const { parseEnv } = require("node:util"); for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(process.argv[1], "utf8")))) process.stdout.write(`${k}=${v}\0`)' "$env_file")
	export PUBLIC_CONVEX_URL="$dev_convex_url" PUBLIC_POSTHOG_KEY= SPROCKET_DATA_DIR="$data_dir"
	export XDG_SESSION_TYPE=x11 PATH="$desktop_scripts/bin:$PATH" SPROCKET_VERIFY_OPENED_URLS="$opened_urls"
}
