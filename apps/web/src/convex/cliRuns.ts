import { query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { modelGatewayUrl } from '@convex/lib/gatewayFetch';
import { getSubscriptionTier } from '@convex/lib/tiers';
import { isRunFinalStatus } from '@convex/lib/validators';

export const context = query({
	args: { threadId: v.optional(v.id('threadRecords')) },
	returns: v.object({
		userId: v.string(),
		gatewayUrl: v.string(),
		tier: v.string(),
		thread: v.union(
			v.null(),
			v.object({
				repositoryKey: v.string(),
				selectedModel: v.string(),
				reasoningEffort: v.string(),
				fastMode: v.boolean(),
				activeRunId: v.union(v.null(), v.id('runs'))
			})
		)
	}),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const record = args.threadId ? await getOwnedThreadRecord(ctx.db, userId, args.threadId) : null;
		const latest = record
			? await ctx.db
					.query('runs')
					.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', record._id))
					.order('desc')
					.first()
			: null;
		return {
			userId,
			gatewayUrl: modelGatewayUrl(),
			tier: await getSubscriptionTier(ctx, userId),
			thread: record
				? {
						repositoryKey: record.repositoryKey,
						selectedModel: record.selectedModel,
						reasoningEffort: record.reasoningEffort,
						fastMode: record.fastMode,
						activeRunId: latest && !isRunFinalStatus(latest.status) ? latest._id : null
					}
				: null
		};
	}
});
