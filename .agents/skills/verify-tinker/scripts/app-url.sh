#!/usr/bin/env bash
# The target is localhost because Vite listens on ::1 only: 127.0.0.1 gives 502 and [::1] gives 500.
source "$(dirname "$0")/common.sh"

tailscale serve --bg --https=5173 http://localhost:5173 >/dev/null
echo "https://$(tailnet_host):5173"
