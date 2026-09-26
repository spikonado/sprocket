'use node';

import { v } from 'convex/values';
import { env, internalAction } from '@convex/_generated/server';

// Removal gate: delete once every browserSessions row predates the Firecrawl
// shutdown (session hard TTL is one hour) or FIRECRAWL_BROWSER_API_KEY is unset.
export const closeLegacySession = internalAction({
	args: { sessionId: v.string() },
	returns: v.null(),
	handler: async (_ctx, { sessionId }) => {
		const key = env.FIRECRAWL_BROWSER_API_KEY?.trim();
		if (!key) return null;
		try {
			await fetch(`https://api.firecrawl.dev/v2/interact/${encodeURIComponent(sessionId)}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${key}` },
				signal: AbortSignal.timeout(30_000)
			});
		} catch {
			// Best-effort; the provider session expires on its own within an hour.
		}
		return null;
	}
});
