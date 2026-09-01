import type { Doc, Id } from '@convex/_generated/dataModel';
import {
	action,
	internalMutation,
	mutation,
	query,
	type MutationCtx
} from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';
import schema from '@convex/schema';
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
	getCompletionStreamState,
	registerCompletionAttemptForRun
} from '@convex/lib/assistantStreamWrites';
import { recordThreadUsageEvent, usageEventId } from '@convex/lib/threadUsage';
import { finalizeRunRecord, matchesFinalizeExpectations } from '@convex/lib/runFinalize';
import { startRunLifecycle } from '@convex/runLifecycle';
import { assertContinuableParent } from '@convex/lib/runResume';
import { requestRunCancellation } from './runLifecycle';
import { enqueueWebToolJob, isCloudWebToolKind } from '@convex/webToolPool';
import { newToolInvocationId } from '@convex/lib/transcriptParts';
import {
	recordCompletionTranscript,
	recordPromptTranscript,
	recordSettledToolTranscripts,
	recordStartedToolTranscript
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
import { bumpThreadSnapshotForRun } from '@convex/lib/threadSnapshots';
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
	toolInvocationId: string;
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
	installationId?: string;
	executorSessionId?: Id<'machineSessions'>;
	continuationOfRunId?: Id<'runs'>;
};

type CreatedGatewayRun = {
	created: boolean;
	runId: Id<'runs'>;
	userId: string;
	promptMessageId?: Id<'threadMessages'>;
	promptPart?: Doc<'threadTranscriptParts'>;
};

type GatewayRunTelemetry = {
	completionTransport: 'gateway';
	gatewayProtocolVersion: number;
	agentVersion?: string;
};

async function createQueuedRunRecord(
	ctx: MutationCtx,
	args: QueuedRunRequest
): Promise<CreatedGatewayRun> {
	const secretHash = await executionSecretHash(args.executionSecret);
	const threadRecord = await getOwnedThreadRecord(ctx.db, args.userId, args.threadId);
	const continuationOfRunId = args.continuationOfRunId;
	const prompt = args.prompt.trim();
	if (!continuationOfRunId && !prompt && args.imageUploadIds.length === 0) {
		throw new Error('Message cannot be empty.');
	}
	const imageUploads = continuationOfRunId
		? []
		: await getOwnedImageUploads(ctx, args.userId, args.imageUploadIds);
	if ((args.installationId === undefined) !== (args.executorSessionId === undefined)) {
		throw new Error('Executor session identity is incomplete.');
	}
	if (args.executorSessionId) {
		const session = await ctx.db.get('machineSessions', args.executorSessionId);
		const installation = await ctx.db
			.query('installations')
			.withIndex('by_userId_and_installationId', (query) =>
				query.eq('userId', args.userId).eq('installationId', args.installationId!)
			)
			.unique();
		if (
			!session ||
			session.userId !== args.userId ||
			session.installationId !== args.installationId ||
			session.supersededAt !== undefined ||
			session.revokedAt !== undefined ||
			installation?.currentSessionId !== session._id
		) {
			throw new Error('Executor session is not active.');
		}
	}

	const existingRun = await ctx.db
		.query('runs')
		.withIndex('by_userId_submissionId', (query) =>
			query.eq('userId', args.userId).eq('submissionId', args.submissionId)
		)
		.unique();
	if (existingRun) {
		return await reconcileExistingQueuedRun(ctx, args, existingRun, secretHash, prompt);
	}
	if (args.executorSessionId) {
		const activeSessionRuns = await ctx.db
			.query('machineSessionRuns')
			.withIndex('by_sessionId_and_active', (query) =>
				query.eq('sessionId', args.executorSessionId!).eq('active', true)
			)
			.take(64);
		if (activeSessionRuns.length >= 64) {
			throw new Error('Executor session has too many active runs.');
		}
	}
	let latestRun = await ctx.db
		.query('runs')
		.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', args.threadId))
		.order('desc')
		.first();
	if (
		latestRun &&
		isClaimedRunStatus(latestRun.status) &&
		!isRunClaimLeaseActive(latestRun, Date.now())
	) {
		await finalizeRunRecord(ctx, latestRun, {
			text: `Run aborted: ${RUN_ABANDONED_BY_AGENT}`,
			status: 'failed',
			lastError: RUN_ABANDONED_BY_AGENT
		});
		latestRun = (await ctx.db.get('runs', latestRun._id)) ?? latestRun;
	} else {
		assertThreadCanStartRun(latestRun?.status);
	}
	if (continuationOfRunId) {
		assertContinuableParent(latestRun, continuationOfRunId);
	}

	const gatewayFields: GatewayRunTelemetry = {
		completionTransport: 'gateway',
		gatewayProtocolVersion: args.protocolVersion
	};
	if (args.agentVersion) {
		gatewayFields.agentVersion = args.agentVersion;
	}
	const runRecord: Omit<Doc<'runs'>, '_id' | '_creationTime'> = {
		threadId: args.threadId,
		userId: args.userId,
		submissionId: args.submissionId,
		status: 'queued' as const,
		executionSecretHash: secretHash,
		completionAttemptSeq: 0,
		selectedModel: args.selectedModel,
		reasoningEffort: args.reasoningEffort,
		serviceTier: args.serviceTier,
		installationId: args.installationId,
		executorSessionId: args.executorSessionId,
		startedAt: Date.now(),
		...gatewayFields
	};
	if (continuationOfRunId) runRecord.continuationOfRunId = continuationOfRunId;
	const runId = await ctx.db.insert('runs', runRecord);
	if (args.executorSessionId) {
		await ctx.db.insert('machineSessionRuns', {
			sessionId: args.executorSessionId,
			runId,
			active: true
		});
	}
	const completionStreamStateId = await ctx.db.insert('completionStreamStates', {
		runId,
		userId: args.userId,
		sequence: 0
	});
	const created: CreatedGatewayRun = {
		created: true,
		runId,
		userId: args.userId
	};
	if (!continuationOfRunId) {
		const promptMessageId = await appendThreadMessage(ctx, {
			threadId: args.threadId,
			runId,
			userId: args.userId,
			type: 'prompt',
			text: prompt,
			imageUploadIds: args.imageUploadIds
		});
		await attachImageUploads(ctx, imageUploads, promptMessageId);
		created.promptMessageId = promptMessageId;
		created.promptPart = await recordPromptTranscript(ctx, {
			threadId: args.threadId,
			userId: args.userId,
			runId,
			text: prompt,
			imageUploadIds: args.imageUploadIds
		});
		await ctx.db.patch('runs', runId, {
			promptMessageId,
			completionStreamStateId
		});
	} else {
		await ctx.db.patch('runs', runId, { completionStreamStateId });
	}
	await ctx.db.patch('threadRecords', threadRecord._id, {
		title: threadRecord.title ?? (prompt || imageUploads[0]?.name || 'New thread').slice(0, 72),
		selectedModel: args.selectedModel,
		reasoningEffort: args.reasoningEffort,
		serviceTier: args.serviceTier
	});
	await bumpThreadSnapshotForRun(ctx, runRecord);
	const lifecycleWorkflowId = await startRunLifecycle(ctx, runId);
	await ctx.db.patch('runs', runId, { lifecycleWorkflowId });
	return created;
}

async function reconcileExistingQueuedRun(
	ctx: MutationCtx,
	args: QueuedRunRequest,
	existingRun: Doc<'runs'>,
	secretHash: string,
	prompt: string
): Promise<CreatedGatewayRun> {
	if (existingRun.executionSecretHash !== secretHash) {
		throw new ConvexError('Submission belongs to a different executor.');
	}
	const continuationMatches =
		(existingRun.continuationOfRunId ?? undefined) === (args.continuationOfRunId ?? undefined);
	if (
		existingRun.threadId !== args.threadId ||
		existingRun.selectedModel !== args.selectedModel ||
		existingRun.reasoningEffort !== args.reasoningEffort ||
		existingRun.serviceTier !== args.serviceTier ||
		!existingRun.completionStreamStateId ||
		existingRun.completionTransport !== 'gateway' ||
		!continuationMatches
	) {
		throw new ConvexError('Submission belongs to a different or incomplete run.');
	}

	if (!existingRun.lifecycleWorkflowId && !isRunFinalStatus(existingRun.status)) {
		const lifecycleWorkflowId = await startRunLifecycle(ctx, existingRun._id);
		await ctx.db.patch('runs', existingRun._id, { lifecycleWorkflowId });
	}

	if (args.continuationOfRunId) {
		if (existingRun.promptMessageId) {
			throw new ConvexError('Submission belongs to a different or incomplete run.');
		}
		return {
			created: false,
			runId: existingRun._id,
			userId: args.userId
		};
	}

	if (!existingRun.promptMessageId) {
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
	const promptPart = await recordPromptTranscript(ctx, {
		threadId: args.threadId,
		userId: args.userId,
		runId: existingRun._id,
		text: prompt,
		imageUploadIds: args.imageUploadIds
	});
	return {
		created: false,
		runId: existingRun._id,
		promptMessageId: existingRun.promptMessageId,
		userId: args.userId,
		promptPart
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

const vCreatedGatewayRun = v.object({
	created: v.boolean(),
	runId: v.id('runs'),
	promptMessageId: v.optional(v.id('threadMessages')),
	userId: v.string(),
	promptPart: v.optional(schema.doc('threadTranscriptParts'))
});

const vCreateGatewayRunResult = vCreatedGatewayRun.extend({
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
		agentVersion: v.optional(v.string()),
		installationId: v.optional(v.string()),
		executorSessionId: v.optional(v.id('machineSessions')),
		continuationOfRunId: v.optional(v.id('runs'))
	},
	returns: vCreatedGatewayRun,
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
		agentVersion: v.optional(v.string()),
		installationId: v.optional(v.string()),
		executorSessionId: v.optional(v.id('machineSessions')),
		continuationOfRunId: v.optional(v.id('runs'))
	},
	returns: vCreateGatewayRunResult,
	handler: async (ctx, args): Promise<Infer<typeof vCreateGatewayRunResult>> => {
		const userId = await getUserId(ctx);
		const gatewayUrl = modelGatewayUrl();
		const request: QueuedRunRequest = {
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
			agentVersion: args.agentVersion,
			installationId: args.installationId,
			executorSessionId: args.executorSessionId
		};
		if (args.continuationOfRunId) request.continuationOfRunId = args.continuationOfRunId;
		const created = await ctx.runMutation(internal.agentRuntime.insertGatewayRun, request);
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

		const isSameClaimRenewal = isClaimedRunStatus(run.status) && run.claimId === args.claimId;

		const nextClaimExpiresAt = claimExpiresAt(now);

		const claimPatch: RunClaimPatch = {
			claimId: args.claimId,
			claimExpiresAt: nextClaimExpiresAt,
			status: isSameClaimRenewal ? run.status : 'running',
			lastError: undefined
		};
		if (!isSameClaimRenewal) claimPatch.completionAttemptSeq = 0;
		await ctx.db.patch('runs', args.runId, claimPatch);
		if (!isSameClaimRenewal) {
			await bumpThreadSnapshotForRun(ctx, run);
		}

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
			if (!run.continuationOfRunId) {
				throw new Error('Run does not contain a user prompt.');
			}
			const selection = coercePersistedSelection(run.selectedModel, run.serviceTier);
			return {
				run: {
					...run,
					selectedModel: selection.modelId,
					serviceTier: selection.serviceTier,
					reasoningEffort: coercePersistedReasoningEffort(selection.modelId, run.reasoningEffort)
				},
				threadRecord,
				prompt: '',
				promptAttachments: [],
				agentHistory: [],
				contextBudget: {
					contextWindowTokens: run.contextWindowTokens ?? 0,
					autoCompactTokenLimit: run.autoCompactTokenLimit ?? 0
				}
			};
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
		assertRunAcceptsModelCompletion(run);
		if (!isRunClaimLeaseActive(run, Date.now())) {
			throw new ConvexError(RUN_NO_LONGER_ACTIVE);
		}
		if (!canRegisterCompletionAttempt(run, args.claimId, args.attemptSeq)) {
			throw new ConvexError(COMPLETION_STREAM_SUPERSEDED);
		}
		await registerCompletionAttemptForRun(ctx, run, args.attemptSeq);
	}
});

export const beginAssistantMessage = mutation({
	args: {
		runId: v.id('runs'),
		executionSecret: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// Retired: agent responses no longer maintain a `threadMessages` row.
		// Kept for the pre-backfill agent contract so old clients fail fast.
		await getExecutionRun(ctx, args.runId, args.executionSecret);
		return null;
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
		assertRunAcceptsModelCompletion(run);
		if (!isRunClaimLeaseActive(run, Date.now())) {
			throw new ConvexError(RUN_NO_LONGER_ACTIVE);
		}
		if (!isCurrentCompletionAttempt(run, args.claimId, args.attemptSeq)) {
			return null;
		}
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
			runId: run._id,
			items: args.items
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
		return finalizeRunRecord(ctx, run, args);
	}
});

export const requestCancellation = mutation({
	args: { runId: v.id('runs') },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const run = await getOwnedRun(ctx.db, userId, args.runId);
		return await requestRunCancellation(ctx, run);
	}
});

/** Retired in-place reopen. Current clients continue with a new run. */
export const reopenRun = mutation({
	args: {
		runId: v.id('runs')
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
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
		return finalizeRunRecord(ctx, run, args);
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
	// visible for the capability, so createGatewayRun may still be in flight.
	// `standDown`: the run belongs to another executor or is past the queued
	// stage, so the caller stops without terminalizing it.
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
			// When the caller is still authenticated, distinguish a duplicate
			// submission owned by another executor from an insert still in flight.
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
		const isContinuation = run.continuationOfRunId !== undefined;
		if (
			run.status !== 'queued' ||
			run.threadId !== args.threadId ||
			run.selectedModel !== args.selectedModel ||
			run.reasoningEffort !== args.reasoningEffort ||
			run.serviceTier !== args.serviceTier
		) {
			return 'standDown';
		}
		if (!isContinuation) {
			const promptMessageId = run.promptMessageId;
			if (!promptMessageId) {
				return 'standDown';
			}
			const promptMessage = await ctx.db.get('threadMessages', promptMessageId);
			if (
				!promptMessage ||
				promptMessage.text !== args.prompt.trim() ||
				!areImageUploadIdsEqual(promptMessage.imageUploadIds, args.imageUploadIds)
			) {
				return 'standDown';
			}
		}
		await finalizeRunRecord(ctx, run, {
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
		if (!canFinalizeAfterClaimFailure(run, args.claimId)) {
			return false;
		}
		return finalizeRunRecord(ctx, run, {
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
			assertRunAcceptsModelCompletion(run);
			if (run.claimId !== args.claimId || !isRunClaimLeaseActive(run, Date.now())) {
				throw new ConvexError(RUN_NO_LONGER_ACTIVE);
			}
			const lastJob = await ctx.db
				.query('executorJobs')
				.withIndex('by_threadId_sequence', (query) => query.eq('threadId', run.threadId))
				.order('desc')
				.first();
			const nextSequence = (lastJob?.sequence ?? -1) + 1;
			const toolInvocationId = newToolInvocationId();

			const job: EnqueuedExecutorJob = {
				threadId: run.threadId,
				runId: args.runId,
				kind: args.kind,
				payload: args.payload,
				hidden: args.hidden ?? false,
				status: 'claimed',
				enqueuedAt: Date.now(),
				claimedAt: Date.now(),
				sequence: nextSequence,
				toolInvocationId
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
			await bumpThreadSnapshotForRun(ctx, run);
			await recordStartedToolTranscript(ctx, {
				threadId: run.threadId,
				userId: run.userId,
				runId: run._id,
				job: { ...job, _id: jobId }
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
