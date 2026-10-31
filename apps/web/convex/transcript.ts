import { query, type MutationCtx, type QueryCtx } from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getExecutionRunRecord, getUserId } from '@convex/lib/auth';
import { imageUploadByStorageId } from '@convex/lib/imageUploads';
import {
	vAttachmentFileDownloadResult,
	vTranscriptPartsResult,
	vTranscriptStateResult
} from '@convex/lib/docs';
import { transcriptHistoryFromNumber } from '@convex/lib/contextHandoff';
import {
	getTranscriptState,
	loadTranscriptPartsByNumbers,
	loadTranscriptPartsPage,
	transcriptPartsForClient
} from '@convex/lib/transcriptParts';

export async function transcriptStateResult(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'threadRecords'>,
	thread: Doc<'threadRecords'> | null
): Promise<Infer<typeof vTranscriptStateResult>> {
	const state = await getTranscriptState(ctx, threadId);

	return {
		threadId,
		totalParts: state?.totalParts ?? 0,
		historyFromNumber: transcriptHistoryFromNumber(thread),
		contextSummary: thread?.contextSummary || undefined,
		reasoningStrippedThroughPartNumber: thread?.reasoningStrippedThroughPartNumber
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

export const getParts = query({
	args: {
		threadId: v.id('threadRecords'),
		numbers: v.array(v.number())
	},
	returns: vTranscriptPartsResult,
	handler: async (ctx, args) => {
		await getOwnedThreadRecord(ctx.db, await getUserId(ctx), args.threadId);

		const parts = await transcriptPartsForClient(
			ctx,
			await loadTranscriptPartsByNumbers(ctx, args.threadId, args.numbers)
		);

		return { threadId: args.threadId, parts };
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
		executionSecret: v.string()
	},
	returns: vTranscriptStateResult,
	handler: async (ctx, args) => {
		const run = await getExecutionRunRecord(ctx, args.runId, args.executionSecret);
		const thread = await ctx.db.get('threadRecords', run.threadId);

		return await transcriptStateResult(ctx, run.threadId, thread);
	}
});

export const getPartsForRun = query({
	args: {
		runId: v.id('runs'),
		executionSecret: v.string(),
		numbers: v.array(v.number())
	},
	returns: vTranscriptPartsResult,
	handler: async (ctx, args) => {
		const run = await getExecutionRunRecord(ctx, args.runId, args.executionSecret);

		const parts = await transcriptPartsForClient(
			ctx,
			await loadTranscriptPartsByNumbers(ctx, run.threadId, args.numbers)
		);

		return { threadId: run.threadId, parts };
	}
});

export const getPartsPageForRun = query({
	args: {
		runId: v.id('runs'),
		executionSecret: v.string(),
		start: v.number(),
		end: v.number(),
		order: v.optional(v.union(v.literal('asc'), v.literal('desc')))
	},
	returns: vTranscriptPartsResult,
	handler: async (ctx, args) => {
		const run = await getExecutionRunRecord(ctx, args.runId, args.executionSecret);

		const parts = await loadTranscriptPartsPage(
			ctx,
			run.threadId,
			args.start,
			args.end,
			args.order
		);

		return { threadId: run.threadId, parts };
	}
});

export const attachmentUrlForRun = query({
	args: {
		runId: v.id('runs'),
		executionSecret: v.string(),
		partNumber: v.number(),
		storageId: v.id('_storage')
	},
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const run = await getExecutionRunRecord(ctx, args.runId, args.executionSecret);

		if (!Number.isSafeInteger(args.partNumber) || args.partNumber < 0) {
			throw new Error('Invalid transcript part number.');
		}

		const part = await ctx.db
			.query('threadTranscriptParts')
			.withIndex('by_threadId_and_number', (query) =>
				query.eq('threadId', run.threadId).eq('number', args.partNumber)
			)
			.unique();

		if (part?.kind !== 'prompt' || !part.prompt) {
			throw new Error('Transcript prompt part not found.');
		}

		if (!part.prompt.imageUploads.some((upload) => upload.storageId === args.storageId)) {
			throw new Error('Attachment not found in transcript part.');
		}

		return await ctx.storage.getUrl(args.storageId);
	}
});

export const attachmentDownloadByStorageId = query({
	args: {
		storageId: v.id('_storage')
	},
	returns: vAttachmentFileDownloadResult,
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const upload = await imageUploadByStorageId(ctx, args.storageId);

		if (!upload || upload.userId !== userId) {
			return null;
		}

		const url = await ctx.storage.getUrl(upload.storageId);

		if (!url) {
			return null;
		}

		return {
			storageId: upload.storageId,
			name: upload.name,
			mediaType: upload.mediaType,
			size: upload.size,
			url
		};
	}
});
