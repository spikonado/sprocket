import type { Doc, Id } from '@convex/_generated/dataModel';
import type { DatabaseReader, DatabaseWriter } from '@convex/_generated/server';

// Per-turn counters live here so token writes don't invalidate the
// thread-scoped subscriptions reading `threadRecords`.

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

async function getUsageRow(
	db: DatabaseReader,
	threadId: Id<'threadRecords'>
): Promise<Doc<'threadUsage'> | null> {
	return await db
		.query('threadUsage')
		.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
		.unique();
}

/** Current counters for a thread. */
export async function getThreadUsageValues(
	db: DatabaseReader,
	thread: Doc<'threadRecords'>
): Promise<ThreadUsageValues> {
	const usageRow = await getUsageRow(db, thread._id);
	return {
		contextTokens: usageRow?.contextTokens,
		totalTokensProcessed: usageRow?.totalTokensProcessed ?? 0
	};
}

/** Upsert the usage row and apply a delta. Validates token counts. */
export async function recordThreadUsage(
	ctx: { db: DatabaseWriter },
	thread: Doc<'threadRecords'>,
	args: { contextTokens?: number; addProcessedTokens?: number }
): Promise<void> {
	if (args.contextTokens !== undefined) {
		assertValidTokenCount(args.contextTokens);
	}
	const usageRow = await getUsageRow(ctx.db, thread._id);
	const next: ThreadUsageValues = {
		contextTokens: args.contextTokens ?? usageRow?.contextTokens,
		totalTokensProcessed: addTokenCounts(
			usageRow?.totalTokensProcessed ?? 0,
			args.addProcessedTokens ?? 0
		)
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
}
