import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';

// Context tokens live outside `threadRecords` so per-turn writes don't
// invalidate thread-scoped subscriptions.

async function getUsageRow(
	db: QueryCtx['db'] | MutationCtx['db'],
	threadId: Id<'threadRecords'>
): Promise<Doc<'threadUsage'> | null> {
	return await db
		.query('threadUsage')
		.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
		.unique();
}

/** Latest provider-reported context size. */
export async function getThreadContextTokens(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<number | undefined> {
	return (await getUsageRow(ctx.db, threadId))?.contextTokens;
}

export async function setThreadContextTokens(
	ctx: MutationCtx,
	thread: Doc<'threadRecords'>,
	contextTokens: number | undefined
): Promise<void> {
	if (contextTokens !== undefined && (!Number.isSafeInteger(contextTokens) || contextTokens < 0)) {
		throw new Error('Invalid token count.');
	}

	const usageRow = await getUsageRow(ctx.db, thread._id);

	if (usageRow) {
		if (usageRow.contextTokens !== contextTokens) {
			await ctx.db.patch('threadUsage', usageRow._id, { contextTokens });
		}
	} else if (contextTokens !== undefined) {
		await ctx.db.insert('threadUsage', {
			threadId: thread._id,
			userId: thread.userId,
			contextTokens
		});
	}
}
