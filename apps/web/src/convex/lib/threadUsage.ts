import type { Doc, Id } from '@convex/_generated/dataModel';
import type { DatabaseReader, DatabaseWriter } from '@convex/_generated/server';

// Per-turn counters live here so token writes don't invalidate the
// thread-scoped subscriptions reading `threadRecords`. Legacy on-thread
// fields migrate lazily (see PR follow-up checklist); drop them after.

type ThreadUsageValues = {
	contextTokens: number | undefined;
	totalTokensProcessed: number;
};

function assertValidTokenCount(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error('Invalid token count.');
	}
}

function addTokenCounts(left: number, right: number): number {
	assertValidTokenCount(left);
	assertValidTokenCount(right);
	const total = left + right;
	assertValidTokenCount(total);
	return total;
}

export function hasLegacyUsageFields(
	thread: Pick<Doc<'threadRecords'>, 'contextTokens' | 'totalTokensProcessed'>
): boolean {
	return thread.contextTokens !== undefined || thread.totalTokensProcessed !== undefined;
}

async function getUsageRow(
	db: DatabaseReader,
	threadId: Id<'threadRecords'>
): Promise<Doc<'threadUsage'> | null> {
	return await db
		.query('threadUsage')
		.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
		.unique();
}

function toUsageValues(
	usageRow: Doc<'threadUsage'> | null,
	thread: Doc<'threadRecords'>
): ThreadUsageValues {
	if (usageRow) {
		return {
			contextTokens: usageRow.contextTokens,
			totalTokensProcessed: usageRow.totalTokensProcessed
		};
	}
	return {
		contextTokens: thread.contextTokens,
		totalTokensProcessed: thread.totalTokensProcessed ?? 0
	};
}

/** Current counters, falling back to unmigrated legacy fields. */
export async function getThreadUsageValues(
	db: DatabaseReader,
	thread: Doc<'threadRecords'>
): Promise<ThreadUsageValues> {
	return toUsageValues(await getUsageRow(db, thread._id), thread);
}

/**
 * Upsert the usage row and apply a delta, folding in (and clearing) any
 * legacy fields in the same transaction. Validates token counts.
 */
export async function recordThreadUsage(
	ctx: { db: DatabaseWriter },
	thread: Doc<'threadRecords'>,
	args: { contextTokens?: number; addProcessedTokens?: number }
): Promise<void> {
	if (args.contextTokens !== undefined) {
		assertValidTokenCount(args.contextTokens);
	}
	const usageRow = await getUsageRow(ctx.db, thread._id);
	const base = toUsageValues(usageRow, thread);
	const next: ThreadUsageValues = {
		contextTokens: args.contextTokens ?? base.contextTokens,
		totalTokensProcessed: addTokenCounts(base.totalTokensProcessed, args.addProcessedTokens ?? 0)
	};
	if (usageRow) {
		await ctx.db.patch(usageRow._id, next);
	} else {
		await ctx.db.insert('threadUsage', {
			threadId: thread._id,
			userId: thread.userId,
			...next
		});
	}
	if (hasLegacyUsageFields(thread)) {
		await ctx.db.patch(thread._id, {
			contextTokens: undefined,
			totalTokensProcessed: undefined
		});
	}
}
