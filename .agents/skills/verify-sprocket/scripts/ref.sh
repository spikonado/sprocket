#!/usr/bin/env bash
# Prints the @ref of the first `snapshot -i` line containing the given text, such as 'button "Files"'.
# `find role button --name X` matches substrings, so it can hit `Attach files` instead.
set -euo pipefail

ref=$(agent-browser snapshot -i 2>/dev/null | grep -F -m1 -- "$1" | grep -o 'ref=e[0-9]*' | cut -d= -f2 || true)
if [[ -z "$ref" ]]; then
	echo "no snapshot line contains: $1" >&2
	exit 1
fi
echo "@$ref"
