import { TableAggregate } from '@convex-dev/aggregate';
import type { DataModel, Doc, Id } from '@convex/_generated/dataModel';
import { components } from '@convex/_generated/api';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';

// Per-turn counters live here so token writes don't invalidate the
// thread-scoped subscriptions reading `threadRecords`.

type ThreadUsageValues = {
	contextTokens: number | undefined;
	totalTokensProcessed: number;
};

type UsageEventInsert = {
	threadId: Id<'threadRecords'>;
	userId: string;
	eventId: string;
	processedTokens: number;
	createdAt: number;
};

export const threadProcessedTokens = new TableAggregate<{
	Namespace: Id<'threadRecords'>;
	Key: string;
	DataModel: DataModel;
	TableName: 'threadUsageEvents';
}>(components.aggregate, {
	namespace: (doc) => doc.threadId,
	sortKey: (doc) => doc.eventId,
	sumValue: (doc) => doc.processedTokens
});

export function usageEventId(kind: 'usage', runId: Id<'runs'>, claimId: string, seq: number) {
	return `${kind}:${runId}:${claimId}:${seq}`;
}

function assertValidTokenCount(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error('Invalid token count.');
	}
}

async function getUsageRow(
	db: QueryCtx['db'] | MutationCtx['db'],
	threadId: Id<'threadRecords'>
): Promise<Doc<'threadUsage'> | null> {
	return await db
		.query('threadUsage')
		.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
		.unique();
}

async function aggregatedProcessedTokens(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<number> {
	return await threadProcessedTokens.sum(ctx, { namespace: threadId });
}

/** Latest provider-reported context size. Does not read the processed-token ledger. */
export async function getThreadContextTokens(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<number | undefined> {
	const usageRow = await getUsageRow(ctx.db, threadId);
	return usageRow?.contextTokens;
}

export async function clearThreadContextTokens(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<void> {
	const usageRow = await getUsageRow(ctx.db, threadId);
	if (!usageRow || usageRow.contextTokens === undefined) return;
	await ctx.db.patch('threadUsage', usageRow._id, { contextTokens: undefined });
}

/** Current counters for a thread. Reads the Aggregate ledger. */
export async function getThreadUsageValues(
	ctx: QueryCtx | MutationCtx,
	thread: Doc<'threadRecords'>
): Promise<ThreadUsageValues> {
	const usageRow = await getUsageRow(ctx.db, thread._id);
	return {
		contextTokens: usageRow?.contextTokens,
		totalTokensProcessed: await aggregatedProcessedTokens(ctx, thread._id)
	};
}

/** Insert an idempotent usage event. */
export async function recordThreadUsageEvent(
	ctx: MutationCtx,
	thread: Doc<'threadRecords'>,
	args: { eventId: string; contextTokens?: number; processedTokens: number }
): Promise<boolean> {
	if (args.contextTokens !== undefined) {
		assertValidTokenCount(args.contextTokens);
	}
	assertValidTokenCount(args.processedTokens);
	const existing = await ctx.db
		.query('threadUsageEvents')
		.withIndex('by_threadId_eventId', (query) =>
			query.eq('threadId', thread._id).eq('eventId', args.eventId)
		)
		.unique();
	if (existing) {
		if (args.contextTokens !== undefined) {
			const usageRow = await getUsageRow(ctx.db, thread._id);
			if (usageRow) {
				await ctx.db.patch('threadUsage', usageRow._id, { contextTokens: args.contextTokens });
			}
		}
		return false;
	}

	const event: UsageEventInsert = {
		threadId: thread._id,
		userId: thread.userId,
		eventId: args.eventId,
		processedTokens: args.processedTokens,
		createdAt: Date.now()
	};
	const eventId = await ctx.db.insert('threadUsageEvents', event);
	const inserted = await ctx.db.get('threadUsageEvents', eventId);
	if (!inserted) {
		throw new Error('Failed to insert usage event.');
	}
	await threadProcessedTokens.insertIfDoesNotExist(ctx, inserted);

	const usageRow = await getUsageRow(ctx.db, thread._id);
	const nextContextTokens = args.contextTokens ?? usageRow?.contextTokens;
	if (usageRow) {
		if (nextContextTokens !== undefined) {
			await ctx.db.patch('threadUsage', usageRow._id, { contextTokens: nextContextTokens });
		}
	} else {
		await ctx.db.insert('threadUsage', {
			threadId: thread._id,
			userId: thread.userId,
			contextTokens: nextContextTokens
		});
	}
	return true;
}
