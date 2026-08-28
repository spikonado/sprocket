import type { Doc, Id } from '@convex/_generated/dataModel';
import {
	action,
	internalMutation,
	mutation,
	query,
	type MutationCtx
} from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';
import { ConvexError, v, type Infer } from 'convex/values';
import { getOwnedRun, getOwnedThreadRecord } from '@convex/lib/access';
import { executionSecretHash, getExecutionRun, getUserId } from '@convex/lib/auth';
import { coercePersistedReasoningEffort, coercePersistedSelection } from '@convex/lib/models';
import { GATEWAY_PROTOCOL_VERSION } from '@convex/lib/gatewayProtocol';
import { modelGatewayTokenSecret, modelGatewayUrl } from '@convex/lib/gatewayFetch';
import { gatewayTokenExpiresAt, mintGatewayToken } from '@convex/lib/gatewayToken';
import { vCompletionActor, vGetContextResult } from '@convex/lib/docs';
import { appendThreadMessage } from '@convex/lib/threadMessages';
import {
	beginAssistantMessageForRun,
	getCompletionStreamState,
	registerCompletionAttemptForRun
} from '@convex/lib/assistantStreamWrites';
import { recordThreadUsageEvent, usageEventId } from '@convex/lib/threadUsage';
import { finalizeRunRecord, matchesFinalizeExpectations } from '@convex/lib/runFinalize';
import { startRunLifecycle } from '@convex/runLifecycle';
import { clearInFlightWork, reopenRunRecord } from '@convex/lib/runResume';
import { enqueueWebToolJob, isCloudWebToolKind } from '@convex/webToolPool';
import {
	recordCompletionTranscript,
	recordPromptTranscript,
	recordSettledToolTranscripts
} from '@convex/lib/transcriptWrites';
import {
	areImageUploadIdsEqual,
	attachImageUploads,
	getOwnedImageUploads
} from '@convex/lib/imageUploads';
import {
	RUN_ABANDONED_BY_AGENT,
	RUN_NO_LONGER_ACTIVE,
	assertRunAcceptsModelCompletion,
	toAgentToolConvexError
} from '@convex/lib/agentErrors';
import { unsupportedClient } from '@convex/lib/unsupportedClient';
import { assertThreadCanStartRun, compareRunStartedAt } from '@convex/lib/runs';
import {
	canRegisterCompletionAttempt,
	canFinalizeAfterClaimFailure,
	canStartRunWithClaim,
	claimExpiresAt,
	isClaimedRunStatus,
	isCurrentCompletionAttempt,
	isRunClaimLeaseActive,
	ownsActiveRunClaim
} from '@convex/lib/runLease';
import { COMPLETION_STREAM_SUPERSEDED, vCompletionStreamEvent } from '@convex/lib/completionStream';
import {
	isRunFinalStatus,
	runFinalStatus,
	vExecutorJobKind,
	vExecutorJobPayload,
	vReasoningEffort,
	vServiceTier,
	vRunFinalStatus,
	vRunStatus,
	vTranscriptCompletionItem
} from '@convex/lib/validators';

type RunClaimPatch = {
	claimId: string;
	claimExpiresAt: number;
	status: Doc<'runs'>['status'];
	lastError: undefined;
	completionAttemptSeq?: number;
	activeJobId?: undefined;
};

type EnqueuedExecutorJob = {
	threadId: Id<'threadRecords'>;
	runId: Id<'runs'>;
	kind: Infer<typeof vExecutorJobKind>;
	payload: Infer<typeof vExecutorJobPayload>;
	hidden: boolean;
	status: 'claimed';
	enqueuedAt: number;
	claimedAt: number;
	sequence: number;
	callId?: string;
};

type QueuedRunRequest = {
	userId: string;
	submissionId: string;
	threadId: Id<'threadRecords'>;
	prompt: string;
	imageUploadIds: Id<'imageUploads'>[];
	selectedModel: string;
	reasoningEffort: Infer<typeof vReasoningEffort>;
	serviceTier: Infer<typeof vServiceTier>;
	executionSecret: string;
	protocolVersion: number;
	agentVersion?: string;
};

type GatewayRunTelemetry = {
	completionTransport: 'gateway';
	gatewayProtocolVersion: number;
	agentVersion?: string;
};

async function createQueuedRunRecord(
	ctx: MutationCtx,
	args: QueuedRunRequest
): Promise<{ created: boolean; runId: Id<'runs'>; promptMessageId: Id<'threadMessages'> }> {
	const secretHash = await executionSecretHash(args.executionSecret);
	const threadRecord = await getOwnedThreadRecord(ctx.db, args.userId, args.threadId);
	const prompt = args.prompt.trim();
	if (!prompt && args.imageUploadIds.length === 0) {
		throw new Error('Message cannot be empty.');
	}
	const imageUploads = await getOwnedImageUploads(ctx, args.userId, args.imageUploadIds);

	const existingRun = await ctx.db
		.query('runs')
		.withIndex('by_userId_submissionId', (query) =>
			query.eq('userId', args.userId).eq('submissionId', args.submissionId)
		)
		.unique();
	if (existingRun) {
		if (existingRun.executionSecretHash !== secretHash) {
			const canRecoverExecutor =
				existingRun.status === 'queued' ||
				(isClaimedRunStatus(existingRun.status) && !isRunClaimLeaseActive(existingRun, Date.now()));
			if (!canRecoverExecutor) {
				throw new ConvexError('Submission belongs to a different active executor.');
			}
			await ctx.db.patch('runs', existingRun._id, { executionSecretHash: secretHash });
		}
		if (
			existingRun.threadId !== args.threadId ||
			existingRun.selectedModel !== args.selectedModel ||
			existingRun.reasoningEffort !== args.reasoningEffort ||
			existingRun.serviceTier !== args.serviceTier ||
			!existingRun.promptMessageId ||
			!existingRun.completionStreamStateId ||
			existingRun.completionTransport !== 'gateway'
		) {
			throw new ConvexError('Submission belongs to a different or incomplete run.');
		}
		const existingPrompt = await ctx.db.get('threadMessages', existingRun.promptMessageId);
		if (
			!existingPrompt ||
			existingPrompt.text !== prompt ||
			!areImageUploadIdsEqual(existingPrompt.imageUploadIds, args.imageUploadIds)
		) {
			throw new Error('Submission prompt does not match the existing run.');
		}

		if (!existingRun.lifecycleWorkflowId && !isRunFinalStatus(existingRun.status)) {
			const lifecycleWorkflowId = await startRunLifecycle(ctx, existingRun._id);
			await ctx.db.patch('runs', existingRun._id, { lifecycleWorkflowId });
		}

		return {
			created: false,
			runId: existingRun._id,
			promptMessageId: existingRun.promptMessageId
		};
	}
	const latestRun = await ctx.db
		.query('runs')
		.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', args.threadId))
		.order('desc')
		.first();
	if (
		latestRun &&
		isClaimedRunStatus(latestRun.status) &&
		!isRunClaimLeaseActive(latestRun, Date.now())
	) {
		await finalizeRunRecord(ctx, args.userId, latestRun, {
			text: `Run aborted: ${RUN_ABANDONED_BY_AGENT}`,
			status: 'failed',
			lastError: RUN_ABANDONED_BY_AGENT
		});
	} else {
		assertThreadCanStartRun(latestRun?.status);
	}

	const gatewayFields: GatewayRunTelemetry = {
		completionTransport: 'gateway',
		gatewayProtocolVersion: args.protocolVersion
	};
	if (args.agentVersion) {
		gatewayFields.agentVersion = args.agentVersion;
	}
	const runId = await ctx.db.insert('runs', {
		threadId: args.threadId,
		userId: args.userId,
		submissionId: args.submissionId,
		status: 'queued' as const,
		executionSecretHash: secretHash,
		completionAttemptSeq: 0,
		selectedModel: args.selectedModel,
		reasoningEffort: args.reasoningEffort,
		serviceTier: args.serviceTier,
		startedAt: Date.now(),
		...gatewayFields
	});
	const completionStreamStateId = await ctx.db.insert('completionStreamStates', {
		runId,
		userId: args.userId,
		sequence: 0
	});
	const promptMessageId = await appendThreadMessage(ctx, {
		threadId: args.threadId,
		runId,
		userId: args.userId,
		type: 'prompt',
		text: prompt,
		imageUploadIds: args.imageUploadIds
	});
	await attachImageUploads(ctx, imageUploads, promptMessageId);
	await ctx.db.patch('runs', runId, {
		promptMessageId,
		completionStreamStateId
	});
	await recordPromptTranscript(ctx, {
		threadId: args.threadId,
		userId: args.userId,
		runId,
		text: prompt,
		imageUploadIds: args.imageUploadIds
	});
	await ctx.db.patch('threadRecords', threadRecord._id, {
		title: threadRecord.title ?? (prompt || imageUploads[0]?.name || 'New thread').slice(0, 72),
		selectedModel: args.selectedModel,
		reasoningEffort: args.reasoningEffort,
		serviceTier: args.serviceTier
	});
	const lifecycleWorkflowId = await startRunLifecycle(ctx, runId);
	await ctx.db.patch('runs', runId, { lifecycleWorkflowId });

	return {
		created: true,
		runId,
		promptMessageId
	};
}

/** Retired Convex createRun. Kept so older agents get an update message. */
export const createRun = mutation({
	args: {
		submissionId: v.optional(v.string()),
		threadId: v.optional(v.string()),
		prompt: v.optional(v.string()),
		imageUploadIds: v.optional(v.array(v.string())),
		selectedModel: v.optional(v.string()),
		reasoningEffort: v.optional(v.string()),
		serviceTier: v.optional(v.string()),
		executionSecret: v.optional(v.string()),
		guestId: v.optional(v.string())
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

const vCreateGatewayRunResult = v.object({
	created: v.boolean(),
	runId: v.id('runs'),
	promptMessageId: v.id('threadMessages'),
	gatewayUrl: v.string(),
	protocolVersion: v.number()
});

export const insertGatewayRun = internalMutation({
	args: {
		userId: v.string(),
		submissionId: v.string(),
		threadId: v.id('threadRecords'),
		prompt: v.string(),
		imageUploadIds: v.array(v.id('imageUploads')),
		selectedModel: v.string(),
		reasoningEffort: vReasoningEffort,
		serviceTier: vServiceTier,
		executionSecret: v.string(),
		protocolVersion: v.number(),
		agentVersion: v.optional(v.string())
	},
	returns: v.object({
		created: v.boolean(),
		runId: v.id('runs'),
		promptMessageId: v.id('threadMessages')
	}),
	handler: async (ctx, args) => {
		return await createQueuedRunRecord(ctx, args);
	}
});

export const createGatewayRun = action({
	args: {
		submissionId: v.string(),
		threadId: v.id('threadRecords'),
		prompt: v.string(),
		imageUploadIds: v.array(v.id('imageUploads')),
		selectedModel: v.string(),
		reasoningEffort: vReasoningEffort,
		serviceTier: vServiceTier,
		executionSecret: v.string(),
		agentVersion: v.optional(v.string())
	},
	returns: vCreateGatewayRunResult,
	handler: async (ctx, args): Promise<Infer<typeof vCreateGatewayRunResult>> => {
		const userId = await getUserId(ctx);
		const gatewayUrl = modelGatewayUrl();
		const created = await ctx.runMutation(internal.agentRuntime.insertGatewayRun, {
			userId,
			submissionId: args.submissionId,
			threadId: args.threadId,
			prompt: args.prompt,
			imageUploadIds: args.imageUploadIds,
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			serviceTier: args.serviceTier,
			executionSecret: args.executionSecret,
			protocolVersion: GATEWAY_PROTOCOL_VERSION,
			agentVersion: args.agentVersion
		});
		return {
			...created,
			gatewayUrl,
			protocolVersion: GATEWAY_PROTOCOL_VERSION
		};
	}
});

export const issueGatewayCredential = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: v.object({
		token: v.string(),
		expiresAt: v.number()
	}),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		if (!ownsActiveRunClaim(run, args.claimId, Date.now())) {
			throw new ConvexError(RUN_NO_LONGER_ACTIVE);
		}
		const expiresAt = gatewayTokenExpiresAt();
		const token = await mintGatewayToken(modelGatewayTokenSecret(), {
			v: 1,
			userId: run.userId,
			exp: expiresAt
		});
		return { token, expiresAt };
	}
});

export const start = mutation({
	args: {
		claimId: v.string(),
		runId: v.id('runs'),
		executionSecret: v.string()
	},
	returns: v.object({
		claimed: v.boolean(),
		claimExpiresAt: v.optional(v.number())
	}),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		const now = Date.now();
		if (!canStartRunWithClaim(run, args.claimId, now)) {
			return { claimed: false };
		}

		const isTakeover = isClaimedRunStatus(run.status) && run.claimId !== args.claimId;
		const isSameClaimRenewal = isClaimedRunStatus(run.status) && run.claimId === args.claimId;
		if (isTakeover) {
			await clearInFlightWork(ctx, run, now);
		}

		const nextClaimExpiresAt = claimExpiresAt(now);

		const claimPatch: RunClaimPatch = {
			claimId: args.claimId,
			claimExpiresAt: nextClaimExpiresAt,
			status: isSameClaimRenewal ? run.status : 'running',
			lastError: undefined
		};
		if (!isSameClaimRenewal) claimPatch.completionAttemptSeq = 0;
		if (isTakeover) claimPatch.activeJobId = undefined;
		await ctx.db.patch('runs', args.runId, claimPatch);

		return { claimed: true, claimExpiresAt: nextClaimExpiresAt };
	}
});

export const renewClaim = mutation({
	args: {
		claimId: v.string(),
		runId: v.id('runs'),
		executionSecret: v.string()
	},
	returns: v.object({
		renewed: v.boolean(),
		claimExpiresAt: v.optional(v.number())
	}),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		// Only active leases renew; expired workers must start/takeover again.
		if (!ownsActiveRunClaim(run, args.claimId, Date.now())) {
			return { renewed: false };
		}

		const nextClaimExpiresAt = claimExpiresAt(Date.now());
		await ctx.db.patch('runs', run._id, { claimExpiresAt: nextClaimExpiresAt });
		return { renewed: true, claimExpiresAt: nextClaimExpiresAt };
	}
});

export const getContext = query({
	args: {
		runId: v.id('runs'),
		executionSecret: v.string()
	},
	returns: vGetContextResult,
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		const userId = run.userId;
		const threadRecord = await getOwnedThreadRecord(ctx.db, userId, run.threadId);
		const promptMessageId = run.promptMessageId;
		if (!promptMessageId) {
			throw new Error('Run does not contain a user prompt.');
		}
		const promptMessage = await ctx.db.get('threadMessages', promptMessageId);
		if (!promptMessage || promptMessage.type !== 'prompt') {
			throw new Error('Run does not contain a user prompt.');
		}
		const promptAttachments = (
			await Promise.all(
				(promptMessage.imageUploadIds ?? []).map(async (imageUploadId) => {
					const upload = await ctx.db.get('imageUploads', imageUploadId);
					if (!upload) return null;
					const url = await ctx.storage.getUrl(upload.storageId);
					return url ? { mediaType: upload.mediaType, url } : null;
				})
			)
		).filter((attachment) => attachment !== null);
		if ((promptMessage.imageUploadIds?.length ?? 0) !== promptAttachments.length) {
			throw new Error('One or more image attachments are unavailable.');
		}

		const prompt = promptMessage.text;
		const selection = coercePersistedSelection(run.selectedModel, run.serviceTier);
		const contextBudget = {
			contextWindowTokens: run.contextWindowTokens ?? 0,
			autoCompactTokenLimit: run.autoCompactTokenLimit ?? 0
		};

		return {
			run: {
				...run,
				selectedModel: selection.modelId,
				serviceTier: selection.serviceTier,
				reasoningEffort: coercePersistedReasoningEffort(selection.modelId, run.reasoningEffort)
			},
			threadRecord,
			prompt,
			promptAttachments,
			agentHistory: [],
			contextBudget
		};
	}
});

export const isFinished = query({
	args: {
		runId: v.id('runs'),
		executionSecret: v.string()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		return isRunFinalStatus(run.status);
	}
});

export const completionActor = query({
	args: {
		runId: v.id('runs'),
		executionSecret: v.string()
	},
	returns: vCompletionActor,
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		const userId = run.userId;
		const streamState = await getCompletionStreamState(ctx, run);
		const actor: Infer<typeof vCompletionActor> = {
			userId,
			threadId: run.threadId,
			status: run.status,
			completionAttemptSeq: run.completionAttemptSeq,
			streamSequence: streamState.sequence
		};
		if (run.claimId) actor.claimId = run.claimId;
		if (run.claimExpiresAt) actor.claimExpiresAt = run.claimExpiresAt;
		if (streamState.streamAttemptId) actor.streamAttemptId = streamState.streamAttemptId;
		return actor;
	}
});

export const saveContextCompaction = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		summary: v.string(),
		processedTokens: v.number(),
		persistForFutureRuns: v.boolean()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		if (!ownsActiveRunClaim(run, args.claimId, Date.now())) return false;
		if (!args.summary.trim()) {
			throw new Error('Invalid context compaction.');
		}
		const thread = await getOwnedThreadRecord(ctx.db, run.userId, run.threadId);
		await recordThreadUsageEvent(ctx, thread, {
			eventId: usageEventId('compaction', run._id, args.claimId, run.completionAttemptSeq),
			processedTokens: args.processedTokens
		});
		let durableSummary:
			{ contextSummary: string; contextSummaryThroughRunId: Id<'runs'> } | undefined;
		if (args.persistForFutureRuns) {
			const previousRun = (
				await Promise.all(
					runFinalStatus.map((status) =>
						ctx.db
							.query('runs')
							.withIndex('by_threadId_status_startedAt', (query) =>
								query
									.eq('threadId', run.threadId)
									.eq('status', status)
									.lte('startedAt', run.startedAt)
							)
							.order('desc')
							.take(4)
					)
				)
			)
				.flat()
				.filter((candidate) => compareRunStartedAt(candidate, run) < 0)
				.sort((left, right) => compareRunStartedAt(right, left))[0];
			// Require a real cutoff run so transcript reads can skip covered parts.
			if (previousRun) {
				durableSummary = {
					contextSummary: args.summary,
					contextSummaryThroughRunId: previousRun._id
				};
			}
		}
		if (durableSummary) {
			await ctx.db.patch('threadRecords', thread._id, durableSummary);
		}
		return true;
	}
});

export const recordContextUsage = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		contextTokens: v.number(),
		processedTokens: v.number()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		if (!ownsActiveRunClaim(run, args.claimId, Date.now())) return false;
		const thread = await getOwnedThreadRecord(ctx.db, run.userId, run.threadId);
		await recordThreadUsageEvent(ctx, thread, {
			eventId: usageEventId('usage', run._id, args.claimId, run.completionAttemptSeq),
			contextTokens: args.contextTokens,
			processedTokens: args.processedTokens
		});
		return true;
	}
});

export const registerCompletionAttempt = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		attemptSeq: v.number(),
		supersededStreamIds: v.optional(v.array(v.string())),
		executionSecret: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		assertRunAcceptsModelCompletion(run.status);
		if (!isRunClaimLeaseActive(run, Date.now())) {
			throw new ConvexError(RUN_NO_LONGER_ACTIVE);
		}
		if (!canRegisterCompletionAttempt(run, args.claimId, args.attemptSeq)) {
			throw new ConvexError(COMPLETION_STREAM_SUPERSEDED);
		}
		// Completion turns stamp parts with turnId = streamId, so a retry can
		// drop the partial parts its prior attempts persisted.
		await registerCompletionAttemptForRun(
			ctx,
			run,
			args.attemptSeq,
			args.supersededStreamIds ?? []
		);
	}
});

export const beginAssistantMessage = mutation({
	args: {
		runId: v.id('runs'),
		executionSecret: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		if (isRunFinalStatus(run.status)) {
			return;
		}
		await getCompletionStreamState(ctx, run);
		await beginAssistantMessageForRun(ctx, run);
	}
});

/** Retired Convex live-token merge. Kept so older agents get an update message. */
export const mergeAssistantStreamEvents = mutation({
	args: {
		runId: v.optional(v.id('runs')),
		claimId: v.optional(v.string()),
		attemptSeq: v.optional(v.number()),
		streamId: v.optional(v.string()),
		sequence: v.optional(v.number()),
		events: v.optional(v.array(vCompletionStreamEvent)),
		executionSecret: v.optional(v.string())
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const finalizeCompletionCall = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		attemptSeq: v.number(),
		streamId: v.string(),
		items: v.array(vTranscriptCompletionItem),
		executionSecret: v.string()
	},
	returns: v.union(v.number(), v.null()),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		assertRunAcceptsModelCompletion(run.status);
		if (!isRunClaimLeaseActive(run, Date.now())) {
			throw new ConvexError(RUN_NO_LONGER_ACTIVE);
		}
		if (!isCurrentCompletionAttempt(run, args.claimId, args.attemptSeq)) {
			return null;
		}
		await beginAssistantMessageForRun(ctx, run);
		const number = await recordCompletionTranscript(ctx, {
			threadId: run.threadId,
			userId: run.userId,
			runId: run._id,
			streamId: args.streamId,
			items: args.items
		});
		await recordSettledToolTranscripts(ctx, {
			threadId: run.threadId,
			userId: run.userId,
			runId: run._id
		});
		return number;
	}
});

export const finalizeRun = mutation({
	args: {
		expectedStatus: v.optional(vRunStatus),
		expectedClaimId: v.optional(v.string()),
		runId: v.id('runs'),
		text: v.string(),
		status: vRunFinalStatus,
		lastError: v.optional(v.string())
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const run = await getOwnedRun(ctx.db, userId, args.runId);
		if (!matchesFinalizeExpectations(run, args)) {
			return false;
		}
		return finalizeRunRecord(ctx, userId, run, args);
	}
});

export const reopenRun = mutation({
	args: {
		runId: v.id('runs')
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const run = await getOwnedRun(ctx.db, userId, args.runId);
		await reopenRunRecord(ctx, run);
		return null;
	}
});

export const finalizeExecutorRun = mutation({
	args: {
		expectedStatus: v.optional(vRunStatus),
		expectedClaimId: v.optional(v.string()),
		runId: v.id('runs'),
		text: v.string(),
		status: vRunFinalStatus,
		lastError: v.optional(v.string()),
		executionSecret: v.string()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		if (!matchesFinalizeExpectations(run, args)) {
			return false;
		}
		return finalizeRunRecord(ctx, run.userId, run, args);
	}
});

export const finalizeFailedStart = mutation({
	args: {
		submissionId: v.string(),
		threadId: v.id('threadRecords'),
		prompt: v.string(),
		imageUploadIds: v.array(v.id('imageUploads')),
		selectedModel: v.string(),
		reasoningEffort: vReasoningEffort,
		serviceTier: vServiceTier,
		text: v.string(),
		lastError: v.string(),
		executionSecret: v.string()
	},
	// `finalized`: the queued run was terminalized. `pending`: nothing is
	// visible for the capability; either createGatewayRun is still in flight or, when
	// the caller's identity is gone, a rebound run cannot be told apart from a
	// missing one, so the caller keeps retrying until its deadline.
	// `standDown`: the run belongs to an active executor (a racing launch
	// rebound it) or is past the queued stage, so the caller stops without
	// terminalizing it.
	returns: v.union(v.literal('finalized'), v.literal('pending'), v.literal('standDown')),
	handler: async (ctx, args) => {
		// The browser identity can be gone by the time this cleanup runs; the
		// execution secret is the capability. A secret match on a still-queued
		// run means it is waiting on this executor, so terminalizing is safe.
		const secretHash = await executionSecretHash(args.executionSecret);
		const run = await ctx.db
			.query('runs')
			.withIndex('by_executionSecretHash', (query) => query.eq('executionSecretHash', secretHash))
			.unique();
		if (!run) {
			// A racing launch may already have rebound the run to its own
			// secret; when the caller is still authenticated, tell the loser to
			// stand down instead of retrying until its deadline.
			const identity = await ctx.auth.getUserIdentity();
			if (identity !== null) {
				const submittedRun = await ctx.db
					.query('runs')
					.withIndex('by_userId_submissionId', (query) =>
						query.eq('userId', identity.subject).eq('submissionId', args.submissionId)
					)
					.unique();
				if (submittedRun) {
					return 'standDown';
				}
			}
			return 'pending';
		}
		if (
			run.status !== 'queued' ||
			run.threadId !== args.threadId ||
			run.selectedModel !== args.selectedModel ||
			run.reasoningEffort !== args.reasoningEffort ||
			run.serviceTier !== args.serviceTier ||
			!run.promptMessageId
		) {
			return 'standDown';
		}
		const promptMessage = await ctx.db.get('threadMessages', run.promptMessageId);
		if (
			!promptMessage ||
			promptMessage.text !== args.prompt.trim() ||
			!areImageUploadIdsEqual(promptMessage.imageUploadIds, args.imageUploadIds)
		) {
			return 'standDown';
		}
		await finalizeRunRecord(ctx, run.userId, run, {
			text: args.text,
			status: 'failed',
			lastError: args.lastError
		});
		return 'finalized';
	}
});

export const finalizeClaimFailure = mutation({
	args: {
		claimId: v.string(),
		runId: v.id('runs'),
		text: v.string(),
		lastError: v.string(),
		executionSecret: v.string()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		const userId = run.userId;
		if (!canFinalizeAfterClaimFailure(run, args.claimId)) {
			return false;
		}
		return finalizeRunRecord(ctx, userId, run, {
			text: args.text,
			status: 'failed',
			lastError: args.lastError
		});
	}
});

export const beginToolJob = mutation({
	args: {
		claimId: v.string(),
		runId: v.id('runs'),
		kind: vExecutorJobKind,
		callId: v.optional(v.string()),
		payload: vExecutorJobPayload,
		hidden: v.optional(v.boolean()),
		executionSecret: v.string()
	},
	returns: v.object({
		jobId: v.id('executorJobs'),
		sequence: v.number()
	}),
	handler: async (ctx, args) => {
		try {
			const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
			assertRunAcceptsModelCompletion(run.status);
			if (run.claimId !== args.claimId || !isRunClaimLeaseActive(run, Date.now())) {
				throw new ConvexError(RUN_NO_LONGER_ACTIVE);
			}
			const lastJob = await ctx.db
				.query('executorJobs')
				.withIndex('by_threadId_sequence', (query) => query.eq('threadId', run.threadId))
				.order('desc')
				.first();
			const nextSequence = (lastJob?.sequence ?? -1) + 1;

			const job: EnqueuedExecutorJob = {
				threadId: run.threadId,
				runId: args.runId,
				kind: args.kind,
				payload: args.payload,
				hidden: args.hidden ?? false,
				status: 'claimed',
				enqueuedAt: Date.now(),
				claimedAt: Date.now(),
				sequence: nextSequence
			};
			if (args.callId) job.callId = args.callId;
			const jobId = await ctx.db.insert('executorJobs', job);
			if (isCloudWebToolKind(args.kind)) {
				await enqueueWebToolJob(ctx, {
					jobId,
					runId: args.runId,
					claimId: args.claimId,
					kind: args.kind
				});
			}

			await ctx.db.patch('runs', args.runId, {
				status: 'awaiting_executor',
				activeJobId: jobId
			});

			return {
				jobId,
				sequence: nextSequence
			};
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});
