import type { Doc, Id } from '@convex/_generated/dataModel';
import type { DatabaseReader, DatabaseWriter } from '@convex/_generated/server';

/**
 * Per-turn token counters live here instead of on `threadRecords`: a context
 * meter only needs the active thread's viewer, while a hot thread document
 * invalidates every thread-scoped subscription for every connected client.
 *
 * Legacy `contextTokens`/`totalTokensProcessed` fields on `threadRecords` are
 * migrated lazily: reads fall back to them, opening a thread schedules
 * `threads.migrateLegacyUsage` (queries cannot schedule), and usage writes
 * fold them in atomically. Once every row is migrated the fields can be
 * dropped from the schema.
 */

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

/** Current counters for a thread, falling back to unmigrated legacy fields. */
export async function getThreadUsageValues(
	db: DatabaseReader,
	thread: Doc<'threadRecords'>
): Promise<ThreadUsageValues> {
	return toUsageValues(await getUsageRow(db, thread._id), thread);
}

/**
 * Upsert the usage row and apply a delta, folding in any legacy fields still
 * on the thread document (and clearing them) in the same transaction.
 * Token counts are validated here; callers don't need to pre-validate.
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
