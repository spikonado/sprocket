import { query, type MutationCtx, type QueryCtx } from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { getOwnedThreadRecord, getOwnedThreadRecordByString } from '@convex/lib/access';
import { getExecutionRunRecord, getUserId } from '@convex/lib/auth';
import { toAgentToolConvexError } from '@convex/lib/agentErrors';
import { vTranscriptPartsResult, vTranscriptStateResult } from '@convex/lib/docs';
import { transcriptContext, transcriptHistoryFromNumber } from '@convex/lib/contextHandoff';
import { getTranscriptState, loadTranscriptPartsPage } from '@convex/lib/transcriptParts';

export async function transcriptStateResult(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'threadRecords'>,
	thread: Doc<'threadRecords'> | null
): Promise<Infer<typeof vTranscriptStateResult>> {
	const state = await getTranscriptState(ctx, threadId);
	const context = transcriptContext(state, thread);

	return {
		threadId,
		totalParts: state?.totalParts ?? 0,
		historyFromNumber: transcriptHistoryFromNumber(context),
		contextSummary: context.contextSummary || undefined,
		reasoningStrippedThroughPartNumber: context.reasoningStrippedThroughPartNumber
	};
}

export const getState = query({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: vTranscriptStateResult,
	handler: async (ctx, args) => {
		const thread = await getOwnedThreadRecord(ctx.db, await getUserId(ctx), args.threadId);

		return await transcriptStateResult(ctx, args.threadId, thread);
	}
});

export const getPartsPage = query({
	args: {
		threadId: v.id('threadRecords'),
		start: v.number(),
		end: v.number(),
		order: v.optional(v.union(v.literal('asc'), v.literal('desc')))
	},
	returns: vTranscriptPartsResult,
	handler: async (ctx, args) => {
		await getOwnedThreadRecord(ctx.db, await getUserId(ctx), args.threadId);

		const parts = await loadTranscriptPartsPage(
			ctx,
			args.threadId,
			args.start,
			args.end,
			args.order
		);

		return { threadId: args.threadId, parts };
	}
});

export const getStateForRun = query({
	args: {
		runId: v.id('runs'),
		executionSecret: v.string(),
		/** Any thread of the run's user. Defaults to the run's thread. */
		threadId: v.optional(v.string())
	},
	returns: vTranscriptStateResult,
	handler: async (ctx, args) => {
		try {
			const run = await getExecutionRunRecord(ctx, args.runId, args.executionSecret);

			const thread = await getOwnedThreadRecordByString(
				ctx.db,
				run.userId,
				args.threadId ?? run.threadId
			);

			return await transcriptStateResult(ctx, thread._id, thread);
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const getPartsPageForRun = query({
	args: {
		runId: v.id('runs'),
		executionSecret: v.string(),
		/** Any thread of the run's user. Defaults to the run's thread. */
		threadId: v.optional(v.string()),
		start: v.number(),
		end: v.number(),
		order: v.optional(v.union(v.literal('asc'), v.literal('desc')))
	},
	returns: vTranscriptPartsResult,
	handler: async (ctx, args) => {
		try {
			const run = await getExecutionRunRecord(ctx, args.runId, args.executionSecret);

			const { _id: threadId } = await getOwnedThreadRecordByString(
				ctx.db,
				run.userId,
				args.threadId ?? run.threadId
			);

			const parts = await loadTranscriptPartsPage(ctx, threadId, args.start, args.end, args.order);

			return { threadId, parts };
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const attachmentUrlForRun = query({
	args: {
		runId: v.id('runs'),
		executionSecret: v.string(),
		partNumber: v.number(),
		storageId: v.string()
	},
	returns: v.null(),
	handler: () => null
});

export const attachmentDownloadByStorageId = query({
	args: { storageId: v.string() },
	returns: v.null(),
	handler: () => null
});
