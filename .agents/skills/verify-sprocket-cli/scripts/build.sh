#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"

cd "$repo_root"
nix develop -c cargo build -p sprocket-cli
mkdir -p "$(dirname "$cli_bin")"
ln -f "$CARGO_TARGET_DIR/debug/sprocket" "$cli_bin"
if ! grep -qaF "$repo_root/crates/sprocket-cli" "$cli_bin"; then
	echo "Another worktree relinked debug/sprocket before the link. Run build.sh again." >&2
	exit 1
fi
echo "$cli_bin"
