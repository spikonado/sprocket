site_scripts="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$site_scripts/../../verify-sprocket/scripts/common.sh"

site_dir="$repo_root/apps/site"
site_port=4335
site_origin="http://localhost:$site_port"

# Hosts that must never be reached while verifying. The prod Convex URL comes from the committed root .env.
prod_hosts_pattern() {
	local prod_host
	prod_host=$(sed -n 's/^PUBLIC_CONVEX_URL=//p' "$repo_root/.env" | tr -d "\"'" | sed 's#^https://##; s#/.*##')
	echo "kpg\.spikonado\.com|posthog\.com|vercel\.live|${prod_host//./\\.}"
}
