#!/usr/bin/env bash
# Usage: record.sh <out-prefix> <command> [args ...]
set -uo pipefail
prefix="$1"
shift
mkdir -p "$(dirname "$prefix")"
printf '%q ' "$@" >"$prefix.cmd"
echo >>"$prefix.cmd"
"$@" >"$prefix.out" 2>"$prefix.err"
code=$?
echo "$code" >"$prefix.exit"
for part in cmd out err exit; do
	echo "--- $part"
	cat "$prefix.$part"
done
exit "$code"
