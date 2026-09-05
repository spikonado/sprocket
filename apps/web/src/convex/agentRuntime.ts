import type { Doc, Id } from '@convex/_generated/dataModel';
import { action, internalMutation, mutation, query } from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';
import schema from '@convex/schema';
import { ConvexError, v, type Infer } from 'convex/values';
import { getOwnedRun, getOwnedThreadRecord } from '@convex/lib/access';
import { getExecutionRun, getUserId } from '@convex/lib/auth';
import { GATEWAY_PROTOCOL_VERSION } from '@convex/lib/gatewayProtocol';
import { modelGatewayTokenSecret, modelGatewayUrl } from '@convex/lib/gatewayFetch';
import { gatewayTokenExpiresAt, mintGatewayToken } from '@convex/lib/gatewayToken';
import { vCompletionActor, vGetContextResult } from '@convex/lib/docs';
import {
	getCompletionStreamState,
	registerCompletionAttemptForRun
} from '@convex/lib/assistantStreamWrites';
import { recordThreadUsageEvent, usageEventId } from '@convex/lib/threadUsage';
import { finalizeRunRecord, matchesFinalizeExpectations } from '@convex/lib/runFinalize';
import { requestRunCancellation } from './runLifecycle';
import {
	recordCompletionTranscript,
	recordSettledToolTranscripts
} from '@convex/lib/transcriptWrites';
import {
	RUN_NO_LONGER_ACTIVE,
	assertRunAcceptsModelCompletion,
	toAgentToolConvexError
} from '@convex/lib/agentErrors';
import { unsupportedClient } from '@convex/lib/unsupportedClient';
import { compareRunStartedAt } from '@convex/lib/runs';
import { setRunAndThreadStatus } from '@convex/lib/threadRunStatus';
import {
	createQueuedRunRecord,
	finalizeFailedQueuedStart,
	type QueuedRunRequest
} from '@convex/lib/runCreate';
import { beginExecutorJob } from '@convex/lib/toolJobs';
import { getPromptPart } from '@convex/lib/transcriptParts';
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
	vCurrentExecutorJobKind,
	vCurrentExecutorJobPayload,
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
	threadId: v.id('threadRecords'),
	promptMessageId: v.optional(v.string()),
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
		threadId: v.optional(v.id('threadRecords')),
		repositoryKey: v.optional(v.string()),
		prompt: v.string(),
		imageUploadIds: v.array(v.id('imageUploads')),
		selectedModel: v.string(),
		reasoningEffort: vReasoningEffort,
		serviceTier: vServiceTier,
		executionSecret: v.string(),
		protocolVersion: v.number(),
		agentVersion: v.optional(v.string()),
		machineId: v.optional(v.string()),
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
		threadId: v.optional(v.id('threadRecords')),
		repositoryKey: v.optional(v.string()),
		prompt: v.string(),
		imageUploadIds: v.array(v.id('imageUploads')),
		selectedModel: v.string(),
		reasoningEffort: vReasoningEffort,
		serviceTier: vServiceTier,
		executionSecret: v.string(),
		agentVersion: v.optional(v.string()),
		machineId: v.optional(v.string()),
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
			repositoryKey: args.repositoryKey,
			prompt: args.prompt,
			imageUploadIds: args.imageUploadIds,
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			serviceTier: args.serviceTier,
			executionSecret: args.executionSecret,
			protocolVersion: GATEWAY_PROTOCOL_VERSION,
			agentVersion: args.agentVersion,
			machineId: args.machineId
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
		await setRunAndThreadStatus(ctx, run, claimPatch.status, claimPatch);

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
		const promptPart = await getPromptPart(ctx, run.threadId, run._id);
		if (!promptPart?.prompt) {
			if (!run.continuationOfRunId) {
				throw new Error('Run does not contain a user prompt.');
			}
			return {
				run,
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
		const promptAttachments = (
			await Promise.all(
				promptPart.prompt.imageUploads.map(async (upload) => {
					const url = await ctx.storage.getUrl(upload.storageId);
					return url ? { mediaType: upload.mediaType, url } : null;
				})
			)
		).filter((attachment) => attachment !== null);
		if (promptPart.prompt.imageUploads.length !== promptAttachments.length) {
			throw new Error('One or more image attachments are unavailable.');
		}

		const prompt = promptPart.prompt.text;
		const contextBudget = {
			contextWindowTokens: run.contextWindowTokens ?? 0,
			autoCompactTokenLimit: run.autoCompactTokenLimit ?? 0
		};

		return {
			run,
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
		return isRunFinalStatus(run.status) || run.cancellationRequestedAt !== undefined;
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
		threadId: v.optional(v.id('threadRecords')),
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
		return await finalizeFailedQueuedStart(ctx, args);
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
		kind: vCurrentExecutorJobKind,
		callId: v.optional(v.string()),
		payload: vCurrentExecutorJobPayload,
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
			return await beginExecutorJob(ctx, {
				run,
				claimId: args.claimId,
				kind: args.kind,
				payload: args.payload,
				callId: args.callId,
				hidden: args.hidden
			});
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});
