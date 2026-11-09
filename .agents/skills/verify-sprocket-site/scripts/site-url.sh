#!/usr/bin/env bash
# The target is localhost because the dev server may listen on ::1 only.
source "$(dirname "$0")/common.sh"

tailscale serve --bg --https="$site_port" "$site_origin" >/dev/null
echo "https://$(tailnet_host):$site_port"
