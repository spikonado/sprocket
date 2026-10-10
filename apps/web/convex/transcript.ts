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
