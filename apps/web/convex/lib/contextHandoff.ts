import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import type { Infer } from 'convex/values';
import type { vProviderHandoff } from '@convex/lib/docs';
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

export function existingThroughPartNumber(thread: Doc<'threadRecords'>): number | undefined {
	const cutoff = thread.contextSummaryThroughPartNumber;

	if (thread.contextSummary !== undefined && cutoff === undefined) {
		throw new Error('Conversation context is missing its history cutoff.');
	}

	return cutoff;
}

export function transcriptHistoryFromNumber(thread: Doc<'threadRecords'> | null): number {
	if (!thread) return 0;
	const throughPartNumber = existingThroughPartNumber(thread);

	return throughPartNumber === undefined ? 0 : throughPartNumber + 1;
}

// Model IDs are opaque. The local runner resolves vendor changes from the live catalog.
export async function getProviderHandoff(
	ctx: QueryCtx | MutationCtx,
	run: Doc<'runs'>,
	thread: Doc<'threadRecords'> | null
): Promise<Infer<typeof vProviderHandoff> | undefined> {
	const completions = ctx.db
		.query('threadTranscriptParts')
		.withIndex('by_threadId_kind_number', (query) =>
			query
				.eq('threadId', run.threadId)
				.eq('kind', 'completion')
				.gte('number', transcriptHistoryFromNumber(thread))
		)
		.order('desc');

	for await (const part of completions) {
		if (part.runId === run._id || !part.completion?.items.length) continue;
		const source = await ctx.db.get('runs', part.runId);

		if (!source) throw new Error('Conversation completion run not found.');
		const completionProvider = source.completionProvider ?? 'spikonado';

		if (
			completionProvider === (run.completionProvider ?? 'spikonado') &&
			source.selectedModel === run.selectedModel
		)
			return undefined;

		return {
			completionProvider,
			selectedModel: source.selectedModel,
			reasoningEffort: source.reasoningEffort,
			fastMode: source.fastMode
		};
	}

	return undefined;
}
