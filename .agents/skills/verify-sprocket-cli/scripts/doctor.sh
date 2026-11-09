#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
set +e

if [[ -x "$cli_bin" ]]; then
	grep -qaF "$repo_root/crates/sprocket-cli" "$cli_bin" &&
		check ok "binary $cli_bin is built from $repo_root" ||
		check fail "binary $cli_bin is from another worktree. Run build.sh."
	newer=$(find "$repo_root/crates" "$repo_root/Cargo.toml" "$repo_root/Cargo.lock" -type f \( -name '*.rs' -o -name 'Cargo.*' \) -newer "$cli_bin" -print -quit)
	[[ -z "$newer" ]] && check ok "binary is newer than every crate source" ||
		check fail "binary is older than $newer. Run build.sh."
	check ok "version: $("$cli_bin" --version)"
else
	check fail "no binary at $cli_bin. Run build.sh."
fi

check ok "Convex: $dev_convex_url (dev, not $prod_convex_url)"

for stub in xdg-open sprocket-desktop; do
	[[ "$(PATH="$cli_scripts/stubs:$PATH" command -v "$stub")" == "$cli_scripts/stubs/$stub" ]] &&
		check ok "$stub resolves to the recording stub" ||
		check fail "$stub does not resolve to $cli_scripts/stubs/$stub"
done

if ! port_busy "$cli_port"; then
	check ok "port $cli_port is free; cli.sh spawns a temporary server"
elif pid=$(own_api_pid); then
	check ok "port $cli_port is this worktree's server, PID $pid"
else
	pids=$(port_pids "$cli_port")
	for pid in $pids; do
		check fail "port $cli_port is held by PID $pid from $(pid_cwd "$pid"). Another agent is verifying, and cli.sh waits for it."
	done
	[[ -n "$pids" ]] || check fail "port $cli_port is held by a process this user can't see"
	exit "$status"
fi

models=$(timeout 90 "$cli_scripts/cli.sh" run --list-models 2>&1)
if [[ $? == 0 ]]; then
	check ok "host signed in; $(grep -c '^  Reasoning' <<<"$models") models listed"
else
	check fail "run --list-models: $(tail -n1 <<<"$models")"
fi

exit "$status"
