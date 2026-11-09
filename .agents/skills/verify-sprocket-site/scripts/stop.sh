#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"

stop_listeners "$site_dir" "$site_port"
if tailscale serve status 2>/dev/null | grep -q ":$site_port "; then
	tailscale serve --https="$site_port" off >/dev/null && echo "removed tailscale serve mapping for :$site_port"
fi
