import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import type { ModelCallUsage, TokenCounts, TokenUsageTotals } from '@convex/lib/validators';

const HOUR_MS = 60 * 60 * 1000;

const DAY_MS = 24 * HOUR_MS;

const emptyCounts: TokenCounts = {
	inputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 0,
	reasoningTokens: 0
};

type UsageTotals = Pick<TokenUsageTotals, 'calls' | 'standard' | 'longContext'>;

function totalsKey(call: ModelCallUsage) {
	return {
		provider: call.provider,
		model: call.model,
		serviceTier: call.serviceTier,
		cacheWriteTtl: call.cacheWriteTtl
	};
}

function assertValidCounts(call: ModelCallUsage): void {
	const valid =
		[
			call.inputTokens,
			call.cacheReadTokens,
			call.cacheWriteTokens,
			call.outputTokens,
			call.reasoningTokens
		].every((count) => Number.isSafeInteger(count) && count >= 0) &&
		call.cacheReadTokens + call.cacheWriteTokens <= call.inputTokens &&
		call.reasoningTokens <= call.outputTokens;

	if (!valid) throw new Error('Invalid token count.');
}

function addCounts(total: TokenCounts, call: TokenCounts): TokenCounts {
	return {
		inputTokens: total.inputTokens + call.inputTokens,
		cacheReadTokens: total.cacheReadTokens + call.cacheReadTokens,
		cacheWriteTokens: total.cacheWriteTokens + call.cacheWriteTokens,
		outputTokens: total.outputTokens + call.outputTokens,
		reasoningTokens: total.reasoningTokens + call.reasoningTokens
	};
}

function addCall(totals: UsageTotals | null, call: ModelCallUsage): UsageTotals {
	const standard = totals?.standard ?? emptyCounts;
	const longContext = totals?.longContext ?? emptyCounts;

	return {
		calls: (totals?.calls ?? 0) + 1,
		standard: call.longContext ? standard : addCounts(standard, call),
		longContext: call.longContext ? addCounts(longContext, call) : longContext
	};
}

export function sumModelCalls(calls: readonly ModelCallUsage[]): TokenUsageTotals[] {
	const totals = new Map<string, TokenUsageTotals>();

	for (const call of calls) {
		const key = JSON.stringify([call.provider, call.model, call.serviceTier]);

		totals.set(key, {
			provider: call.provider,
			model: call.model,
			serviceTier: call.serviceTier,
			...addCall(totals.get(key) ?? null, call, callCounts(call))
		});
	}

	return [...totals.values()];
}

async function addToThreadTotals(
	ctx: MutationCtx,
	thread: Doc<'threadRecords'>,
	call: ModelCallUsage
) {
	const existing = await ctx.db
		.query('threadTokenUsage')
		.withIndex('by_threadId_model', (query) =>
			query
				.eq('threadId', thread._id)
				.eq('provider', call.provider)
				.eq('model', call.model)
				.eq('serviceTier', call.serviceTier)
				.eq('cacheWriteTtl', call.cacheWriteTtl)
		)
		.unique();

	const totals = addCall(existing, call);

	if (existing) {
		await ctx.db.patch('threadTokenUsage', existing._id, totals);
	} else {
		await ctx.db.insert('threadTokenUsage', {
			threadId: thread._id,
			userId: thread.userId,
			...totalsKey(call),
			...totals
		});
	}
}

async function addToUserBucket(
	ctx: MutationCtx,
	userId: string,
	granularity: 'hour' | 'day',
	now: number,
	call: ModelCallUsage
) {
	const size = granularity === 'hour' ? HOUR_MS : DAY_MS;
	const bucketStart = now - (now % size);

	const existing = await ctx.db
		.query('userTokenUsage')
		.withIndex('by_userId_bucket', (query) =>
			query
				.eq('userId', userId)
				.eq('granularity', granularity)
				.eq('bucketStart', bucketStart)
				.eq('provider', call.provider)
				.eq('model', call.model)
				.eq('serviceTier', call.serviceTier)
				.eq('cacheWriteTtl', call.cacheWriteTtl)
		)
		.unique();

	const totals = addCall(existing, call);

	if (existing) {
		await ctx.db.patch('userTokenUsage', existing._id, totals);
	} else {
		await ctx.db.insert('userTokenUsage', {
			userId,
			granularity,
			bucketStart,
			...totalsKey(call),
			...totals
		});
	}
}

/** Records one completion call once per `eventId`; retries leave every total unchanged. */
export async function recordModelCallUsage(
	ctx: MutationCtx,
	thread: Doc<'threadRecords'>,
	args: {
		runId: Id<'runs'>;
		eventId: string;
		call: ModelCallUsage;
	}
): Promise<void> {
	assertValidCounts(args.call);

	const existing = await ctx.db
		.query('modelCallUsage')
		.withIndex('by_runId_eventId', (query) =>
			query.eq('runId', args.runId).eq('eventId', args.eventId)
		)
		.unique();

	if (existing) return;

	await ctx.db.insert('modelCallUsage', {
		userId: thread.userId,
		runId: args.runId,
		eventId: args.eventId,
		...args.call
	});

	const now = Date.now();
	await addToThreadTotals(ctx, thread, args.call);
	await addToUserBucket(ctx, thread.userId, 'hour', now, args.call);
	await addToUserBucket(ctx, thread.userId, 'day', now, args.call);
}
