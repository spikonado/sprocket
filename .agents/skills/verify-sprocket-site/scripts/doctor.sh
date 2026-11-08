#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
load_dev_env
set +e

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$site_origin/")
[[ "$code" == 200 ]] && check ok "site: $site_origin/ -> 200" || check fail "site: $site_origin/ -> $code"

# The module the browser and SSR import, so it shows the values actually in use, .env files included.
env_module=$(curl -s --max-time 10 "$site_origin/@id/__x00__astro:env/client" | head -1)
[[ "$env_module" == *"PUBLIC_CONVEX_URL = \"$dev_convex_url\""* ]] && check ok "Convex: $dev_convex_url (dev)" ||
	check fail "astro:env/client is not the dev Convex URL: $env_module. Stop it now."
[[ "$env_module" == *"PUBLIC_POSTHOG_KEY = undefined"* ]] && check ok "PUBLIC_POSTHOG_KEY undefined, so no analytics" ||
	check fail "PUBLIC_POSTHOG_KEY is set in astro:env/client. Stop it now."

server_seen=
for pid in $(port_pids "$site_port"); do
	cwd=$(pid_cwd "$pid")
	if [[ "$cwd" != "$site_dir" ]]; then
		check fail "PID $pid on port $site_port runs from $cwd, not this worktree"
		continue
	fi
	server_seen=1
	net_log=$(pid_env "$pid" SITE_NET_LOG)
	if [[ -f "$net_log" ]]; then
		prod=$(grep -E "$(prod_hosts_pattern)" "$net_log")
		[[ -z "$prod" ]] && check ok "no prod requests in $net_log" || check fail "prod requests in $net_log: $prod"
	else
		check fail "no server requests log for PID $pid"
	fi
done
[[ -n "$server_seen" ]] || check fail "no site server from this worktree on port $site_port"

exit "$status"
