import { query } from '@convex/_generated/server';
import { v } from 'convex/values';
import schema from '@convex/schema';
import { getOwnedRun, getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { modelGatewayUrl } from '@convex/lib/gatewayFetch';
import { getSubscriptionTier } from '@convex/lib/tiers';
import { fastModeForStoredRecord } from '@convex/lib/fastMode';
import { isRunFinalStatus, vRunStatus } from '@convex/lib/validators';

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
						fastMode: fastModeForStoredRecord(record),
						activeRunId: latest && !isRunFinalStatus(latest.status) ? latest._id : null
					}
				: null
		};
	}
});

export const snapshot = query({
	args: { runId: v.id('runs'), afterPart: v.number() },
	returns: v.object({
		runId: v.id('runs'),
		threadId: v.id('threadRecords'),
		status: vRunStatus,
		error: v.union(v.null(), v.string()),
		parts: v.array(schema.doc('threadTranscriptParts')),
		hasMore: v.boolean()
	}),
	handler: async (ctx, args) => {
		if (!Number.isSafeInteger(args.afterPart) || args.afterPart < -1) {
			throw new Error('Invalid transcript cursor.');
		}
		const run = await getOwnedRun(ctx.db, await getUserId(ctx), args.runId);
		const page = await ctx.db
			.query('threadTranscriptParts')
			.withIndex('by_threadId_and_runId_and_number', (q) =>
				q.eq('threadId', run.threadId).eq('runId', run._id).gt('number', args.afterPart)
			)
			.take(17);
		return {
			runId: run._id,
			threadId: run.threadId,
			status: run.status,
			error: run.lastError ?? null,
			parts: page.slice(0, 16),
			hasMore: page.length > 16
		};
	}
});
