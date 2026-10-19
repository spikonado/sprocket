#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
load_dev_env

# Without these, the CLI uses the shell's or the compiled-in prod deployment.
export PUBLIC_CONVEX_URL="$dev_convex_url" SPROCKET_DATA_DIR="$data_dir" SPROCKET_PORT=7731
exec "$CARGO_TARGET_DIR/debug/sprocket" login "$@"
