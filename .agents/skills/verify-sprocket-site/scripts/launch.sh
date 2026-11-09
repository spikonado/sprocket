#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
load_dev_env
evidence_root=/tmp/verify-sprocket-site

take_port_lock "${XDG_RUNTIME_DIR:-/tmp}/sprocket-verify-site.lock" "$site_port"

mkdir -p "$evidence_root"
export SITE_NET_LOG="$evidence_root/server-requests-$(date +%Y%m%d-%H%M%S).log"
: >"$SITE_NET_LOG"
echo "Port $site_port free. Server requests log: $SITE_NET_LOG" >&2

# The shell exports the prod PostHog key and Convex URL. Without a key the site sends no analytics.
unset PUBLIC_POSTHOG_KEY PUBLIC_POSTHOG_HOST POSTHOG_PERSONAL_API_KEY POSTHOG_PROJECT_ID
export PUBLIC_CONVEX_URL="$dev_convex_url" ASTRO_TELEMETRY_DISABLED=1
export NODE_OPTIONS="--require $site_scripts/net-log.cjs ${NODE_OPTIONS:-}"
allow_tailnet_host

bun_install

cd "$site_dir"
exec nix develop "$repo_root" -c bun run dev --port "$site_port"
