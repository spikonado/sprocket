const HTTP = /^(https?):$/i;

/** Links the agent can put in a visual. Other schemes stay as text. */
export function safeExternalHref(href: string | null | undefined): string | undefined {
	if (href == null) return undefined;

	const trimmed = href.trim();

	if (!trimmed || trimmed.startsWith('//')) return undefined;

	try {
		const url = new URL(trimmed);

		if (HTTP.test(url.protocol)) return trimmed;

		return undefined;
	} catch {
		return /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? undefined : trimmed;
	}
}
