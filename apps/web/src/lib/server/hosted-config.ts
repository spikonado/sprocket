/** Public runtime env for hosted `/api/config`. Never copies non-PUBLIC keys. */
export function publicRuntimeEnv(env: Record<string, string | undefined>) {
	const entries: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith('PUBLIC_') || value === undefined) {
			continue;
		}
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			continue;
		}
		entries[key] = trimmed;
	}
	return entries;
}
