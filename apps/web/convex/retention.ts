import { v } from 'convex/values';
import type { WithoutSystemFields } from 'convex/server';
import { internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from '@convex/_generated/server';
import { deleteThread } from '@convex/lib/threadDeletion';
import { hierarchyState, subtreeSummary } from '@convex/lib/threadHierarchy';
import { resolvePlan } from '@convex/lib/tiers';

const DAY_MS = 24 * 60 * 60 * 1_000;

export const RETENTION_GRACE_MS = 14 * DAY_MS;

const USER_BATCH_SIZE = 16;

const THREAD_BATCH_SIZE = 16;

type RetentionState = WithoutSystemFields<Doc<'threadRetention'>>;

/** Undefined means unlimited. A shorter limit only applies once the grace period ends. */
function effectiveDays(state: RetentionState | null, now: number): number | undefined {
	if (!state) return undefined;

	const longerBefore = state.previousDays === undefined || state.previousDays > state.days;

	return longerBefore && now - state.changedAt < RETENTION_GRACE_MS
		? state.previousDays
		: state.days;
}

/** Plans change through webhooks, granted tiers, and tier edits, so the sweep detects changes here. */
async function syncRetentionDays(
	ctx: MutationCtx,
	userId: string,
	now: number
): Promise<number | undefined> {
	const days = (await resolvePlan(ctx, userId, now)).limits.retentionDays;

	const state = await ctx.db
		.query('threadRetention')
		.withIndex('by_userId', (query) => query.eq('userId', userId))
		.unique();

	if (days === undefined) {
		if (state) await ctx.db.delete('threadRetention', state._id);

		return undefined;
	}

	if (state?.days === days) return effectiveDays(state, now);

	const next = { userId, days, previousDays: effectiveDays(state, now), changedAt: now };

	if (state) {
		await ctx.db.replace('threadRetention', state._id, next);
	} else {
		await ctx.db.insert('threadRetention', next);
	}

	return effectiveDays(next, now);
}

function staleRoots(ctx: QueryCtx, userId: string, cutoff: number) {
	return ctx.db
		.query('threadRecords')
		.withIndex('by_userId_and_parentThreadId_and_lastMessageAt', (query) =>
			query.eq('userId', userId).eq('parentThreadId', undefined).lt('lastMessageAt', cutoff)
		);
}

/** Thread owners need no `users` row, since CLI sign-in never creates one. */
async function nextThreadOwner(ctx: QueryCtx, afterUserId: string | undefined) {
	const thread = await ctx.db
		.query('threadRecords')
		.withIndex('by_userId_lastMessageAt', (query) =>
			afterUserId === undefined ? query : query.gt('userId', afterUserId)
		)
		.first();

	return thread?.userId;
}

async function isExpired(ctx: QueryCtx, root: Doc<'threadRecords'>, cutoff: number) {
	const lastDescendantActivityAt = (await hierarchyState(ctx.db, root._id))
		?.lastDescendantActivityAt;

	if (lastDescendantActivityAt !== undefined && lastDescendantActivityAt >= cutoff) return false;

	return !(await subtreeSummary(ctx.db, root)).anyActive;
}

export const sweep = internalMutation({
	args: { afterUserId: v.optional(v.string()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = Date.now();
		let afterUserId = args.afterUserId;

		for (let visited = 0; visited < USER_BATCH_SIZE; visited++) {
			const userId = await nextThreadOwner(ctx, afterUserId);

			if (userId === undefined) return null;
			afterUserId = userId;
			const days = await syncRetentionDays(ctx, userId, now);

			if (days === undefined) continue;
			const cutoff = now - days * DAY_MS;

			if (await staleRoots(ctx, userId, cutoff).first()) {
				await ctx.scheduler.runAfter(0, internal.retention.sweepUser, {
					userId,
					cutoff,
					cursor: null
				});
			}
		}

		await ctx.scheduler.runAfter(0, internal.retention.sweep, { afterUserId });

		return null;
	}
});

export const sweepUser = internalMutation({
	args: { userId: v.string(), cutoff: v.number(), cursor: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const roots = await staleRoots(ctx, args.userId, args.cutoff).paginate({
			cursor: args.cursor,
			numItems: THREAD_BATCH_SIZE
		});

		for (const root of roots.page) {
			if (await isExpired(ctx, root, args.cutoff)) await deleteThread(ctx, root);
		}

		if (!roots.isDone) {
			await ctx.scheduler.runAfter(0, internal.retention.sweepUser, {
				...args,
				cursor: roots.continueCursor
			});
		}

		return null;
	}
});
