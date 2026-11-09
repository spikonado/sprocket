#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
out="${1:?usage: net-check.sh <evidence dir containing browser.har>}"

net_log=
for pid in $(port_pids "$site_port"); do
	[[ "$(pid_cwd "$pid")" == "$site_dir" ]] && net_log=$(pid_env "$pid" SITE_NET_LOG)
done
if [[ ! -f "$net_log" ]]; then
	echo "FAIL no site server from this worktree on port $site_port. Run net-check before cleanup." >&2
	exit 1
fi
cp "$net_log" "$out/server-requests.log"

python3 - "$out/browser.har" >"$out/browser-requests.log" <<'EOF'
import json, sys
for entry in json.load(open(sys.argv[1]))["log"]["entries"]:
    print(entry["request"]["method"], entry["request"]["url"], entry["response"]["status"])
EOF

echo "== off-site browser requests"
{ grep -v " $site_origin/" "$out/browser-requests.log" || true; } | cut -d'?' -f1 | sort | uniq -c
echo "== server requests"
cut -d' ' -f3- "$out/server-requests.log" | cut -d'?' -f1 | sort | uniq -c

prod=$(grep -hE "$(prod_hosts_pattern)" "$out/browser-requests.log" "$out/server-requests.log" || true)
if [[ -n "$prod" ]]; then
	echo "FAIL prod requests:" >&2
	echo "$prod" >&2
	exit 1
fi
echo "ok   no requests to PostHog, Vercel Live or prod Convex"
