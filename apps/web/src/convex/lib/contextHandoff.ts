import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import { getPromptPart, getTranscriptState } from '@convex/lib/transcriptParts';

/** Inclusive last covered part when a handoff covers no transcript prefix. */
export const EMPTY_CONTEXT_PREFIX_THROUGH_PART_NUMBER = -1;

export function contextHandoffKey(runId: Id<'runs'>, claimId: string, attemptSeq: number): string {
	return `${runId}:${claimId}:${attemptSeq}`;
}

async function partNumberForRun(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'threadRecords'>,
	runId: Id<'runs'>,
	order: 'asc' | 'desc'
): Promise<number | undefined> {
	const part = await ctx.db
		.query('threadTranscriptParts')
		.withIndex('by_threadId_and_runId_and_number', (query) =>
			query.eq('threadId', threadId).eq('runId', runId)
		)
		.order(order)
		.first();
	return part?.number;
}

export async function throughPartNumberForRunId(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'threadRecords'>,
	runId: Id<'runs'>
): Promise<number> {
	const lastCovered = await partNumberForRun(ctx, threadId, runId, 'desc');
	return lastCovered ?? EMPTY_CONTEXT_PREFIX_THROUGH_PART_NUMBER;
}

async function lastTranscriptPartNumber(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<number> {
	const state = await getTranscriptState(ctx, threadId);
	if (!state || state.totalParts <= 0) return EMPTY_CONTEXT_PREFIX_THROUGH_PART_NUMBER;
	return state.totalParts - 1;
}

/** Inclusive last transcript part covered by a durable handoff. */
export async function throughPartNumberForHandoff(
	ctx: QueryCtx | MutationCtx,
	args: { threadId: Id<'threadRecords'>; runId: Id<'runs'>; beforePrompt: boolean }
): Promise<number> {
	if (args.beforePrompt) {
		const promptPart = await getPromptPart(ctx, args.threadId, args.runId);
		if (promptPart) return promptPart.number - 1;
		const firstRunPart = await partNumberForRun(ctx, args.threadId, args.runId, 'asc');
		if (firstRunPart !== undefined) return firstRunPart - 1;
	} else {
		const lastRunPart = await partNumberForRun(ctx, args.threadId, args.runId, 'desc');
		if (lastRunPart !== undefined) return lastRunPart;
	}
	return await lastTranscriptPartNumber(ctx, args.threadId);
}

export async function existingThroughPartNumber(
	ctx: QueryCtx | MutationCtx,
	thread: Doc<'threadRecords'>
): Promise<number | undefined> {
	if (thread.contextSummaryThroughPartNumber !== undefined) {
		return thread.contextSummaryThroughPartNumber;
	}
	if (!thread.contextSummaryThroughRunId) return undefined;
	return await throughPartNumberForRunId(ctx, thread._id, thread.contextSummaryThroughRunId);
}

export async function transcriptHistoryFromNumber(
	ctx: QueryCtx | MutationCtx,
	thread: Doc<'threadRecords'> | null
): Promise<number> {
	if (!thread) return 0;
	const throughPartNumber = await existingThroughPartNumber(ctx, thread);
	if (throughPartNumber === undefined) return 0;
	return throughPartNumber + 1;
}
