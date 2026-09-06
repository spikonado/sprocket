import { vOnCompleteArgs } from '@convex-dev/workpool';
import { ConvexError, v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import {
	env,
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx
} from '@convex/_generated/server';
import {
	RUN_CANCELLED_BY_USER,
	RUN_NO_LONGER_ACTIVE,
	toAgentToolConvexError
} from '@convex/lib/agentErrors';
import { getExecutionRun } from '@convex/lib/auth';
import {
	HOSTED_PARSE_MAX_INPUT_BYTES,
	HOSTED_PARSE_TTL_MS,
	hostedParseUploadFilename,
	registeredParseStorage,
	shortHostedParseError,
	vHostedParseClientStatus
} from '@convex/lib/hostedParse';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import { isSettledExecutorJobStatus } from '@convex/lib/runs';
import { isRunFinalStatus, registeredFileUploadError } from '@convex/lib/validators';
import { webToolWorkpool } from '@convex/webToolPool';

const CLEANUP_BATCH_SIZE = 100;

function configuredFirecrawlApiKey(): string | undefined {
	return env.FIRECRAWL_API_KEY?.trim() || undefined;
}

const vHostedParseContext = v.object({
	requestId: v.id('hostedParseRequests'),
	jobId: v.id('executorJobs'),
	runId: v.id('runs'),
	claimId: v.string()
});

export const createUpload = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		jobId: v.id('executorJobs')
	},
	returns: v.object({
		requestId: v.id('hostedParseRequests'),
		uploadUrl: v.optional(v.string())
	}),
	handler: async (ctx, args) => {
		try {
			if (!configuredFirecrawlApiKey()) {
				throw new ConvexError('Hosted document parsing is not configured.');
			}
			const { run, job } = await requireActiveParseJob(ctx, args);
			const existing = await requestForJob(ctx, job._id);
			if (existing) {
				if (
					existing.runId !== run._id ||
					existing.claimId !== args.claimId ||
					existing.expiresAt <= Date.now()
				) {
					throw new ConvexError('Hosted parse request not found.');
				}
				return createUploadResponse(existing);
			}
			const uploadUrl = await ctx.storage.generateUploadUrl();
			const requestId = await ctx.db.insert('hostedParseRequests', {
				jobId: job._id,
				runId: run._id,
				userId: run.userId,
				claimId: args.claimId,
				status: 'awaiting_upload',
				uploadUrl,
				expiresAt: Date.now() + HOSTED_PARSE_TTL_MS
			});
			await ctx.scheduler.runAfter(HOSTED_PARSE_TTL_MS, internal.hostedParse.cleanupExpiredOne, {
				requestId
			});
			return { requestId, uploadUrl };
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const start = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		requestId: v.id('hostedParseRequests'),
		storageId: v.id('_storage'),
		filename: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		try {
			if (!configuredFirecrawlApiKey()) {
				throw new ConvexError('Hosted document parsing is not configured.');
			}
			const request = await ctx.db.get('hostedParseRequests', args.requestId);
			if (!request || request.runId !== args.runId) {
				throw new ConvexError('Hosted parse request not found.');
			}
			const { run, job } = await requireActiveParseJob(ctx, {
				runId: args.runId,
				claimId: args.claimId,
				executionSecret: args.executionSecret,
				jobId: request.jobId
			});
			if (request.claimId !== args.claimId || request.expiresAt <= Date.now()) {
				throw new ConvexError(RUN_NO_LONGER_ACTIVE);
			}
			if (request.status !== 'awaiting_upload') {
				return null;
			}
			await requireUnregisteredStorage(ctx, args.storageId);
			const filenameError = registeredFileUploadError(args.filename);
			const filename = hostedParseUploadFilename(args.filename);
			if (filenameError || !filename) {
				await ctx.storage.delete(args.storageId);
				await ctx.db.patch('hostedParseRequests', request._id, {
					status: 'failed',
					error: 'Filename must be between 1 and 255 characters.',
					uploadUrl: undefined
				});
				return null;
			}
			const metadata = await ctx.db.system.get('_storage', args.storageId);
			if (!metadata) {
				await ctx.db.patch('hostedParseRequests', request._id, {
					status: 'failed',
					error: 'Uploaded file was not found.',
					uploadUrl: undefined
				});
				return null;
			}
			if (metadata.size > HOSTED_PARSE_MAX_INPUT_BYTES) {
				await ctx.storage.delete(args.storageId);
				await ctx.db.patch('hostedParseRequests', request._id, {
					status: 'failed',
					error: 'File exceeds the 50 MB hosted parse limit.',
					uploadUrl: undefined
				});
				return null;
			}
			await ctx.db.patch('hostedParseRequests', request._id, {
				status: 'pending',
				claimId: args.claimId,
				inputStorageId: args.storageId,
				filename,
				uploadUrl: undefined
			});
			const workId = await webToolWorkpool.enqueueAction(
				ctx,
				internal.hostedParseActions.executeHostedParse,
				{
					requestId: request._id,
					jobId: job._id,
					runId: run._id,
					claimId: args.claimId
				},
				{
					retry: false,
					onComplete: internal.hostedParse.completeHostedParse,
					context: {
						requestId: request._id,
						jobId: job._id,
						runId: run._id,
						claimId: args.claimId
					}
				}
			);
			await ctx.db.patch('executorJobs', job._id, { cloudWorkId: workId });
			return null;
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const getResult = query({
	args: {
		runId: v.id('runs'),
		executionSecret: v.string(),
		requestId: v.id('hostedParseRequests')
	},
	returns: v.object({
		status: vHostedParseClientStatus,
		url: v.optional(v.string()),
		error: v.optional(v.string())
	}),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		const request = await ctx.db.get('hostedParseRequests', args.requestId);
		if (!request || request.runId !== run._id) {
			throw new ConvexError('Hosted parse request not found.');
		}
		const job = await ctx.db.get('executorJobs', request.jobId);
		if (
			!job ||
			job.runId !== run._id ||
			isSettledExecutorJobStatus(job.status) ||
			!ownsActiveRunClaim(run, request.claimId, Date.now()) ||
			request.expiresAt <= Date.now() ||
			run.cancellationRequestedAt !== undefined ||
			isRunFinalStatus(run.status)
		) {
			return { status: 'failed' as const, error: 'Parse was cancelled.' };
		}
		if (request.status === 'failed') {
			return { status: 'failed' as const, error: request.error ?? 'Firecrawl parse failed.' };
		}
		if (request.status === 'completed') {
			if (!request.resultStorageId) {
				return { status: 'failed' as const, error: 'Parsed document is no longer available.' };
			}
			const url = await ctx.storage.getUrl(request.resultStorageId);
			if (!url) {
				return { status: 'failed' as const, error: 'Parsed document is no longer available.' };
			}
			return { status: 'completed' as const, url };
		}
		return { status: 'pending' as const };
	}
});

export const getParseWork = internalQuery({
	args: {
		requestId: v.id('hostedParseRequests'),
		jobId: v.id('executorJobs'),
		runId: v.id('runs'),
		claimId: v.string()
	},
	returns: v.union(
		v.null(),
		v.object({
			inputStorageId: v.id('_storage'),
			filename: v.string()
		})
	),
	handler: async (ctx, args) => {
		const request = await ctx.db.get('hostedParseRequests', args.requestId);
		if (
			!request ||
			request.jobId !== args.jobId ||
			request.runId !== args.runId ||
			request.claimId !== args.claimId ||
			request.status !== 'pending' ||
			!request.inputStorageId ||
			!request.filename
		) {
			return null;
		}
		const job = await ctx.db.get('executorJobs', args.jobId);
		if (!job || job.runId !== args.runId || job.kind !== 'parse_file') {
			return null;
		}
		if (isSettledExecutorJobStatus(job.status)) {
			return null;
		}
		const run = await ctx.db.get('runs', args.runId);
		if (
			!run ||
			isRunFinalStatus(run.status) ||
			run.cancellationRequestedAt !== undefined ||
			!ownsActiveRunClaim(run, args.claimId, Date.now()) ||
			request.expiresAt <= Date.now()
		) {
			return null;
		}
		return { inputStorageId: request.inputStorageId, filename: request.filename };
	}
});

export const completeHostedParse = internalMutation({
	args: vOnCompleteArgs(vHostedParseContext),
	returns: v.null(),
	handler: async (ctx, args) => {
		const request = await ctx.db.get('hostedParseRequests', args.context.requestId);
		if (!request || request.jobId !== args.context.jobId || request.runId !== args.context.runId) {
			await deleteReturnedResult(ctx, args.result);
			return null;
		}
		if (request.status !== 'pending') {
			await deleteReturnedResult(ctx, args.result);
			return null;
		}
		const job = await ctx.db.get('executorJobs', args.context.jobId);
		const run = await ctx.db.get('runs', args.context.runId);
		const cancelled =
			!job ||
			job.runId !== args.context.runId ||
			isSettledExecutorJobStatus(job.status) ||
			!run ||
			isRunFinalStatus(run.status) ||
			run.cancellationRequestedAt !== undefined ||
			!ownsActiveRunClaim(run, args.context.claimId, Date.now()) ||
			request.expiresAt <= Date.now();
		const claimMismatch = request.claimId !== args.context.claimId;
		if (claimMismatch) {
			await deleteReturnedResult(ctx, args.result);
			return null;
		}
		if (cancelled || args.result.kind === 'canceled') {
			await deleteReturnedResult(ctx, args.result);
			await deleteTemporaryStorage(ctx, request.inputStorageId);
			await ctx.db.patch('hostedParseRequests', request._id, {
				status: 'failed',
				error: 'Parse was cancelled.',
				inputStorageId: undefined,
				uploadUrl: undefined
			});
			return null;
		}
		await deleteTemporaryStorage(ctx, request.inputStorageId);
		if (args.result.kind === 'success' && args.result.returnValue.resultStorageId) {
			const resultStorageId = args.result.returnValue.resultStorageId;
			await requireUnregisteredStorage(ctx, resultStorageId);
			await ctx.db.patch('hostedParseRequests', request._id, {
				status: 'completed',
				resultStorageId,
				inputStorageId: undefined,
				uploadUrl: undefined,
				error: undefined
			});
			return null;
		}
		await ctx.db.patch('hostedParseRequests', request._id, {
			status: 'failed',
			error: shortHostedParseError(
				args.result.kind === 'failed' ? args.result.error : 'Hosted parse returned no result.'
			),
			inputStorageId: undefined,
			uploadUrl: undefined
		});
		return null;
	}
});

export const cleanupExpiredOne = internalMutation({
	args: { requestId: v.id('hostedParseRequests') },
	returns: v.null(),
	handler: async (ctx, args) => {
		const request = await ctx.db.get('hostedParseRequests', args.requestId);
		if (!request || request.expiresAt > Date.now()) {
			return null;
		}
		await deleteHostedParseRequest(ctx, request);
		return null;
	}
});

export const cleanupExpired = internalMutation({
	args: {},
	returns: v.number(),
	handler: async (ctx): Promise<number> => {
		const now = Date.now();
		const requests = await ctx.db
			.query('hostedParseRequests')
			.withIndex('by_expiresAt', (query) => query.gt('expiresAt', 0).lte('expiresAt', now))
			.take(CLEANUP_BATCH_SIZE);
		for (const request of requests) {
			await deleteHostedParseRequest(ctx, request);
		}
		if (requests.length === CLEANUP_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.hostedParse.cleanupExpired, {});
		}
		return requests.length;
	}
});

function createUploadResponse(request: Doc<'hostedParseRequests'>) {
	if (request.status === 'awaiting_upload' && request.uploadUrl) {
		return { requestId: request._id, uploadUrl: request.uploadUrl };
	}
	return { requestId: request._id };
}

async function requireActiveParseJob(
	ctx: MutationCtx | QueryCtx,
	args: {
		runId: Id<'runs'>;
		claimId: string;
		executionSecret: string;
		jobId: Id<'executorJobs'>;
	}
) {
	const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
	if (run.cancellationRequestedAt !== undefined) {
		throw new ConvexError(RUN_CANCELLED_BY_USER);
	}
	if (isRunFinalStatus(run.status) || !ownsActiveRunClaim(run, args.claimId, Date.now())) {
		throw new ConvexError(RUN_NO_LONGER_ACTIVE);
	}
	const job = await ctx.db.get('executorJobs', args.jobId);
	if (!job || job.runId !== run._id || job.kind !== 'parse_file') {
		throw new ConvexError('Executor job not found.');
	}
	if (isSettledExecutorJobStatus(job.status)) {
		throw new ConvexError(RUN_NO_LONGER_ACTIVE);
	}
	return { run, job };
}

async function requestForJob(ctx: MutationCtx, jobId: Id<'executorJobs'>) {
	return await ctx.db
		.query('hostedParseRequests')
		.withIndex('by_jobId', (query) => query.eq('jobId', jobId))
		.unique();
}

async function deleteHostedParseRequest(
	ctx: MutationCtx,
	request: Doc<'hostedParseRequests'>
): Promise<void> {
	await deleteTemporaryStorage(ctx, request.inputStorageId);
	await deleteTemporaryStorage(ctx, request.resultStorageId);
	await ctx.db.delete('hostedParseRequests', request._id);
}

async function deleteReturnedResult(
	ctx: MutationCtx,
	result: {
		kind: string;
		returnValue?: { resultStorageId?: Id<'_storage'> };
	}
): Promise<void> {
	if (result.kind !== 'success' || !result.returnValue?.resultStorageId) return;
	if (await registeredParseStorage(ctx, result.returnValue.resultStorageId)) return;
	await deleteTemporaryStorage(ctx, result.returnValue.resultStorageId);
}

async function deleteTemporaryStorage(
	ctx: MutationCtx,
	storageId: Id<'_storage'> | undefined
): Promise<void> {
	if (!storageId) return;
	const attached = await ctx.db
		.query('imageUploads')
		.withIndex('by_storageId', (query) => query.eq('storageId', storageId))
		.unique();
	if (attached) return;
	if (await ctx.db.system.get('_storage', storageId)) {
		await ctx.storage.delete(storageId);
	}
}

async function requireUnregisteredStorage(
	ctx: MutationCtx,
	storageId: Id<'_storage'>
): Promise<void> {
	const attachment = await ctx.db
		.query('imageUploads')
		.withIndex('by_storageId', (q) => q.eq('storageId', storageId))
		.first();
	if (attachment || (await registeredParseStorage(ctx, storageId))) {
		throw new ConvexError('Hosted parsing requires a dedicated temporary upload.');
	}
}
