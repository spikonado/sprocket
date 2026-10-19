#!/usr/bin/env bash
# Creates or reuses a small git repo to add as a project, and prints its path.
# No remote: a clone of this repo would attach to the existing Sprocket project instead of creating a new one.
set -euo pipefail

dir="${1:-/tmp/verify-sprocket-scratch}"
if [[ ! -d "$dir/.git" ]]; then
	mkdir -p "$dir/src"
	printf '# Scratch\n' >"$dir/README.md"
	printf 'export const answer = 42;\n' >"$dir/src/index.ts"
	git -C "$dir" init -q
	git -C "$dir" add -A
	git -C "$dir" -c user.name=verify -c user.email=verify@localhost -c commit.gpgsign=false commit -qm init
fi
echo "$dir"
