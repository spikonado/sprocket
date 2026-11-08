#!/usr/bin/env bash
# Vercel's ignored build step, run from apps/site: exit 0 skips the build, any other code builds.
# Production always builds. Only deploy hooks start it, and the desktop release hook rebuilds a
# commit that is already deployed.
set -uo pipefail

if [[ "${VERCEL_ENV:-}" == production ]]; then
	exit 1
fi

base="${VERCEL_GIT_PREVIOUS_SHA:-}"

# A branch's first preview has no previous deployment, so compare with where it left main.
if [[ -z "$base" ]]; then
	git fetch --quiet --depth=100 origin main && base="$(git merge-base FETCH_HEAD HEAD)" || exit 1
fi

git diff --quiet "$base" HEAD -- . ../web/convex ../web/convex.json ../../bun.lock
