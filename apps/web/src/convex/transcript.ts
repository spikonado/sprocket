import { query, type QueryCtx } from '@convex/_generated/server';
import { v } from 'convex/values';
import type { Id } from '@convex/_generated/dataModel';
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
	transcriptPartsForClient
} from '@convex/lib/transcriptParts';

async function transcriptStateResult(
	ctx: QueryCtx,
	threadId: Id<'threadRecords'>
): Promise<{
	threadId: Id<'threadRecords'>;
	totalParts: number;
	historyFromNumber: number;
	contextSummary?: string;
}> {
	const state = await getTranscriptState(ctx, threadId);
	const thread = await ctx.db.get('threadRecords', threadId);
	const historyFromNumber = await transcriptHistoryFromNumber(ctx, thread);
	if (thread?.contextSummary) {
		return {
			threadId,
			totalParts: state?.totalParts ?? 0,
			historyFromNumber,
			contextSummary: thread.contextSummary
		};
	}
	return {
		threadId,
		totalParts: state?.totalParts ?? 0,
		historyFromNumber
	};
}

async function requireOwnedThread(ctx: QueryCtx, threadId: Id<'threadRecords'>) {
	await getOwnedThreadRecord(ctx.db, await getUserId(ctx), threadId);
}

export const getState = query({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: vTranscriptStateResult,
	handler: async (ctx, args) => {
		await requireOwnedThread(ctx, args.threadId);
		return await transcriptStateResult(ctx, args.threadId);
	}
});

export const getParts = query({
	args: {
		threadId: v.id('threadRecords'),
		numbers: v.array(v.number())
	},
	returns: vTranscriptPartsResult,
	handler: async (ctx, args) => {
		await requireOwnedThread(ctx, args.threadId);
		const parts = await transcriptPartsForClient(
			ctx,
			await loadTranscriptPartsByNumbers(ctx, args.threadId, args.numbers)
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
		return await transcriptStateResult(ctx, run.threadId);
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
