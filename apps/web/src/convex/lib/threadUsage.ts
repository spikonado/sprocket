import type { Doc, Id } from '@convex/_generated/dataModel';
import type { DatabaseReader, DatabaseWriter, MutationCtx } from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';

/**
 * Per-turn token counters live here instead of on `threadRecords`: a context
 * meter only needs the active thread's viewer, while a hot thread document
 * invalidates every thread-scoped subscription for every connected client.
 *
 * Legacy `contextTokens`/`totalTokensProcessed` fields on `threadRecords` are
 * migrated lazily: reads fall back to them and schedule `migrateLegacyUsage`,
 * writes fold them in atomically. Once every row is migrated the fields can be
 * dropped from the schema.
 */

export type ThreadUsageValues = {
	contextTokens: number | undefined;
	totalTokensProcessed: number;
};

export function assertValidTokenCount(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error('Invalid token count.');
	}
}

export function addTokenCounts(left: number, right: number): number {
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

/**
 * Kick the lazy migration when an access path encounters an unmigrated row.
 * Only mutations can schedule; read paths fall back to the legacy values via
 * `getThreadUsageValues` until some write/open migrates the row.
 */
export async function scheduleLegacyUsageMigration(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.threads.migrateLegacyUsage, { threadId });
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

/** Current counters for a thread, falling back to unmigrated legacy fields. */
export async function getThreadUsageValues(
	db: DatabaseReader,
	thread: Doc<'threadRecords'>
): Promise<ThreadUsageValues> {
	const usageRow = await getUsageRow(db, thread._id);
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

/**
 * Upsert the usage row and apply a delta, folding in any legacy fields still
 * on the thread document (and clearing them) in the same transaction.
 */
export async function recordThreadUsage(
	ctx: { db: DatabaseReader & DatabaseWriter },
	thread: Doc<'threadRecords'>,
	args: { contextTokens?: number; addProcessedTokens?: number }
): Promise<ThreadUsageValues> {
	if (args.contextTokens !== undefined) {
		assertValidTokenCount(args.contextTokens);
	}
	const usageRow = await getUsageRow(ctx.db, thread._id);
	const base: ThreadUsageValues = usageRow
		? {
				contextTokens: usageRow.contextTokens,
				totalTokensProcessed: usageRow.totalTokensProcessed
			}
		: {
				contextTokens: thread.contextTokens,
				totalTokensProcessed: thread.totalTokensProcessed ?? 0
			};
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
	return next;
}
