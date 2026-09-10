import { validate } from 'convex-helpers/validators';
import { ConvexError, type GenericValidator, type Infer } from 'convex/values';
import type { vRequestArgs } from '@convex/firecrawlRequests';
import { internal } from '@convex/_generated/api';
import type { ActionCtx } from '@convex/_generated/server';

export async function runFirecrawlRequest<V extends GenericValidator>(
	ctx: ActionCtx,
	args: Infer<typeof vRequestArgs> & { executionSecret: string },
	returns: V
): Promise<Infer<V>> {
	const id = await ctx.runMutation(internal.firecrawlRequests.enqueue, args);
	try {
		for (;;) {
			const result = await ctx.runMutation(internal.firecrawlRequests.poll, { id });
			if (result.status === 'failed')
				throw new ConvexError(result.error ?? 'Firecrawl request failed.');
			if (result.status === 'completed') {
				const blob = result.storageId ? await ctx.storage.get(result.storageId) : null;
				if (!blob) throw new ConvexError('Firecrawl result is no longer available.');
				const value: unknown = JSON.parse(await blob.text());
				if (!validate(returns, value))
					throw new ConvexError('Firecrawl returned an invalid result.');
				return value;
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	} finally {
		await ctx.runMutation(internal.firecrawlRequests.cleanup, { id });
	}
}
