import { mutation, query, type MutationCtx, type QueryCtx } from '@convex/_generated/server';
import { v } from 'convex/values';
import type { Id } from '@convex/_generated/dataModel';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getExecutionRun, ownerKeysFromIdentity, type OwnerKeys } from '@convex/lib/auth';
import {
	vSessionCredentialProof,
	authorizeBySessionCredential,
	type SessionCredentialProof
} from '@convex/lib/sessionCredentials';
import {
	vAttachmentDownloadResult,
	vTranscriptPartsResult,
	vTranscriptStateResult
} from '@convex/lib/docs';
import {
	getOrCreateTranscriptState,
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

/** Resolves owner keys from the WorkOS identity when present, otherwise from
 * an executor's session credential. Lets released server binaries keep using
 * their JWTs while new ones authenticate with the rotating credential. */
async function resolveCallerKeys(
	ctx: QueryCtx | MutationCtx,
	ticket?: SessionCredentialProof
): Promise<OwnerKeys> {
	const identity = await ctx.auth.getUserIdentity();
	if (identity) {
		return ownerKeysFromIdentity(identity);
	}
	if (!ticket) {
		throw new Error('Authentication required.');
	}
	const owner = await authorizeBySessionCredential(ctx, ticket);
	if (!owner) {
		throw new Error('Authentication required.');
	}
	return owner;
}

/** Name is frozen for current desktop/server callers. Creates transcript state only. */
export const ensureMigrated = mutation({
	args: {
		threadId: v.id('threadRecords'),
		sessionTicket: v.optional(vSessionCredentialProof)
	},
	returns: vTranscriptStateResult,
	handler: async (ctx, args) => {
		const keys = await resolveCallerKeys(ctx, args.sessionTicket);
		await getOwnedThreadRecord(ctx.db, keys, args.threadId);
		await getOrCreateTranscriptState(ctx, {
			threadId: args.threadId,
			userId: keys.userId
		});
		return await transcriptStateResult(ctx, args.threadId);
	}
});

export const getState = query({
	args: {
		threadId: v.id('threadRecords'),
		sessionTicket: v.optional(vSessionCredentialProof)
	},
	returns: vTranscriptStateResult,
	handler: async (ctx, args) => {
		await getOwnedThreadRecord(
			ctx.db,
			await resolveCallerKeys(ctx, args.sessionTicket),
			args.threadId
		);
		return await transcriptStateResult(ctx, args.threadId);
	}
});

export const getParts = query({
	args: {
		threadId: v.id('threadRecords'),
		numbers: v.array(v.number()),
		sessionTicket: v.optional(vSessionCredentialProof)
	},
	returns: vTranscriptPartsResult,
	handler: async (ctx, args) => {
		await getOwnedThreadRecord(
			ctx.db,
			await resolveCallerKeys(ctx, args.sessionTicket),
			args.threadId
		);
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
		imageUploadId: v.id('imageUploads'),
		sessionTicket: v.optional(vSessionCredentialProof)
	},
	returns: vAttachmentDownloadResult,
	handler: async (ctx, args) => {
		const keys = await resolveCallerKeys(ctx, args.sessionTicket);
		const upload = await ctx.db.get('imageUploads', args.imageUploadId);
		if (!upload || (upload.userId !== keys.userId && upload.userId !== keys.subject)) {
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
