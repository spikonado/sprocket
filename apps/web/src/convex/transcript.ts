import { mutation, query, type MutationCtx, type QueryCtx } from '@convex/_generated/server';
import { v } from 'convex/values';
import type { Id } from '@convex/_generated/dataModel';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getExecutionRun, getUserId } from '@convex/lib/auth';
import {
	vAttachmentDownloadResult,
	vTranscriptPartsResult,
	vTranscriptStateResult
} from '@convex/lib/docs';
import { ensureThreadTranscriptMigrated } from '@convex/lib/transcriptMigrate';
import {
	getTranscriptState,
	hydrateTranscriptPartUrls,
	loadTranscriptPartsByNumbers
} from '@convex/lib/transcriptParts';

async function transcriptStateResult(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<{
	threadId: Id<'threadRecords'>;
	totalParts: number;
	historyFromNumber: number;
	contextSummary?: string;
}> {
	const state = await getTranscriptState(ctx, threadId);
	const thread = await ctx.db.get('threadRecords', threadId);
	let historyFromNumber = 0;
	if (thread?.contextSummaryThroughRunId) {
		const cutoffRunId = thread.contextSummaryThroughRunId;
		const lastCovered = await ctx.db
			.query('threadTranscriptParts')
			.withIndex('by_threadId_and_runId_and_number', (query) =>
				query.eq('threadId', threadId).eq('runId', cutoffRunId)
			)
			.order('desc')
			.first();
		if (lastCovered) {
			historyFromNumber = lastCovered.number + 1;
		}
	}
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

export const ensureMigrated = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: vTranscriptStateResult,
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);
		await ensureThreadTranscriptMigrated(ctx, {
			threadId: args.threadId,
			userId
		});
		return await transcriptStateResult(ctx, args.threadId);
	}
});

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
		const parts = await hydrateTranscriptPartUrls(
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
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
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
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		const parts = await hydrateTranscriptPartUrls(
			ctx,
			await loadTranscriptPartsByNumbers(ctx, run.threadId, args.numbers)
		);
		return { threadId: run.threadId, parts };
	}
});

export const attachmentDownload = query({
	args: {
		imageUploadId: v.id('imageUploads')
	},
	returns: vAttachmentDownloadResult,
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const upload = await ctx.db.get('imageUploads', args.imageUploadId);
		if (!upload || upload.userId !== userId) {
			return null;
		}
		const url = await ctx.storage.getUrl(upload.storageId);
		if (!url) {
			return null;
		}
		return {
			imageUploadId: upload._id,
			name: upload.name,
			mediaType: upload.mediaType,
			size: upload.size,
			storageId: upload.storageId,
			url
		};
	}
});
