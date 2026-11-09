#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
load_dev_env
set +e

for name in Xvfb openbox; do
	pid=$(display_pid "$name")
	[[ -n "$pid" ]] && check ok "$name $pid on :$(cat "$state_dir/display")" || check fail "no $name from launch.sh ($state_dir/$name.pid)"
done

user_agent=$(curl -fs --max-time 3 "http://127.0.0.1:$cdp_port/json/version" | sed -n 's/.*"User-Agent": "\(.*\)".*/\1/p')
[[ "$user_agent" == *Electron/* ]] && check ok "CDP $cdp_port: $(grep -o 'Electron/[0-9.]*' <<<"$user_agent")" || check fail "no Electron CDP on 127.0.0.1:$cdp_port"
for pid in $(port_pids "$cdp_port"); do
	[[ "$(pid_cwd "$pid")" == "$desktop_dir" ]] && check ok "$(ps -o comm= -p "$pid") $pid on $cdp_port runs from $desktop_dir" || check fail "PID $pid on $cdp_port runs from $(pid_cwd "$pid")"
done

curl -fs --max-time 3 "http://127.0.0.1:$cdp_port/json/list" | grep -q '"url": "http://localhost:5173/' &&
	check ok "window shows http://localhost:5173/" || check fail "no page target on http://localhost:5173/"

check_dev_http
for pid in $(port_pids 7731); do
	cmd=$(pid_cmdline "$pid")
	[[ "$(pid_cwd "$pid")" == "$desktop_dir" && "$cmd" == *"--data-dir $data_dir"* ]] &&
		check ok "API $pid spawned by Electron with --data-dir $data_dir" || check fail "API $pid is not Electron's: $(pid_cwd "$pid"): $cmd"
	check_api_convex "$pid"
done
for pid in $(port_pids 5173); do
	[[ "$(pid_cwd "$pid")" == "$repo_root/apps/web" ]] && check ok "Vite runs from $repo_root/apps/web" || check fail "PID $pid on 5173 runs from $(pid_cwd "$pid")"
done

exit "$status"
