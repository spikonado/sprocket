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
	--cmd-url-env-var-name PUBLIC_CONVEX_URL \
	--cmd 'bun run --cwd ../site build'

# A new preview's first push can use up its write limit, so the seed retries. It runs on every
# build, unlike --preview-run, so a rebuild still seeds a preview whose first seed failed.
for attempt in 1 2 3 4; do
	bunx convex run --preview-name "$VERCEL_GIT_COMMIT_REF" previews:seed && break
	[[ $attempt == 4 ]] && exit 1
	sleep $((attempt * 5))
done

bunx convex env set --preview-name "$VERCEL_GIT_COMMIT_REF" \
	SPROCKET_MARKETING_ORIGIN "https://$VERCEL_BRANCH_URL"
