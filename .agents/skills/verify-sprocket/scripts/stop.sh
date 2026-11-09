#!/usr/bin/env bash
# Run after terminating the launch.sh session: `convex dev --start 'vite dev'` leaves Vite running under PID 1.
source "$(dirname "$0")/common.sh"

stop_listeners "$repo_root:$repo_root/apps/web" "${dev_ports[@]}"
