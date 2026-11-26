import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { internalMutation, type QueryCtx } from '@convex/_generated/server';
import { deleteThread } from '@convex/lib/threadDeletion';
import { hierarchyState, subtreeSummary } from '@convex/lib/threadHierarchy';

export const RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;

const THREAD_BATCH_SIZE = 16;

async function isExpired(ctx: QueryCtx, root: Doc<'threadRecords'>, cutoff: number) {
	const lastActivityAt = (await hierarchyState(ctx.db, root._id))?.lastActivityAt;

	if (lastActivityAt !== undefined && lastActivityAt >= cutoff) return false;

	return !(await subtreeSummary(ctx.db, root)).anyActive;
}

export const sweep = internalMutation({
	args: { cutoff: v.optional(v.number()), cursor: v.optional(v.string()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const cutoff = args.cutoff ?? Date.now() - RETENTION_MS;

		const roots = await ctx.db
			.query('threadRecords')
			.withIndex('by_parentThreadId_and_lastMessageAt', (query) =>
				query.eq('parentThreadId', undefined).lt('lastMessageAt', cutoff)
			)
			.paginate({ cursor: args.cursor ?? null, numItems: THREAD_BATCH_SIZE });

		for (const root of roots.page) {
			if (await isExpired(ctx, root, cutoff)) await deleteThread(ctx, root);
		}

		if (!roots.isDone) {
			await ctx.scheduler.runAfter(0, internal.retention.sweep, {
				cutoff,
				cursor: roots.continueCursor
			});
		}

		return null;
	}
});
