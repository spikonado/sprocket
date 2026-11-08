#!/usr/bin/env bash
# Vercel's build command, run from apps/site. Production only builds the site against the
# PUBLIC_CONVEX_URL set in Vercel, because convex-production.yml deploys production Convex.
# Previews deploy apps/web/convex to a Convex preview named after the branch, then build against it.
set -euo pipefail

if [[ "${VERCEL_ENV:-}" != preview ]]; then
	exec bun run build
fi

cd ../web
bunx convex deploy \
	--preview-name "$VERCEL_GIT_COMMIT_REF" \
	--preview-run previews:seed \
	--cmd-url-env-var-name PUBLIC_CONVEX_URL \
	--cmd 'bun run --cwd ../site build'
# Checkout return URLs follow this origin.
bunx convex env set --preview-name "$VERCEL_GIT_COMMIT_REF" \
	SPROCKET_MARKETING_ORIGIN "https://$VERCEL_BRANCH_URL"
