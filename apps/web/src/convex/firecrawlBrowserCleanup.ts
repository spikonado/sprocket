'use node';

import { v } from 'convex/values';
import { env, internalAction } from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';

const GONE_STATUSES = new Set([404, 410]);
const MAX_ATTEMPTS = 5;

// Removal gate: delete once every browserSessions row predates the Firecrawl
// shutdown (session hard TTL is one hour) or FIRECRAWL_BROWSER_API_KEY is unset.
export const closeLegacySession = internalAction({
	args: { sessionId: v.string(), attempt: v.optional(v.number()) },
	returns: v.null(),
	handler: async (ctx, { sessionId, attempt = 0 }) => {
		const key = env.FIRECRAWL_BROWSER_API_KEY?.trim();
		if (!key) return null;
		let retry: boolean;
		try {
			const response = await fetch(
				`https://api.firecrawl.dev/v2/interact/${encodeURIComponent(sessionId)}`,
				{
					method: 'DELETE',
					headers: { Authorization: `Bearer ${key}` },
					signal: AbortSignal.timeout(30_000)
				}
			);
			retry = !response.ok && !GONE_STATUSES.has(response.status);
		} catch {
			retry = true;
		}
		if (retry && attempt + 1 < MAX_ATTEMPTS) {
			await ctx.scheduler.runAfter(
				30_000 * 2 ** attempt,
				internal.firecrawlBrowserCleanup.closeLegacySession,
				{ sessionId, attempt: attempt + 1 }
			);
		}
		return null;
	}
});
