import type { Doc, Id } from '@convex/_generated/dataModel';
import { mutation, query, type MutationCtx } from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';
import { getOwnedRun, getOwnedThreadRecord, getOwnedWorkspaceSession } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { buildCanonicalAgentHistory, findLatestPrompt } from '@convex/lib/agentHistory';
import { appendThreadMessage, getThreadMessage } from '@convex/lib/threadMessages';
import { buildThreadTranscript, type ThreadTranscriptMessage } from '@convex/lib/threadTranscript';
import { assertRunAcceptsModelCompletion } from '@convex/lib/agentErrors';
import { assertThreadCanStartRun, cancelExecutorJobsForTerminalRun } from '@convex/lib/runs';
import {
	canFinalizeAfterClaimFailure,
	canStartRunWithClaim,
	claimExpiresAt,
	isClaimedRunStatus,
	isRunClaimLeaseActive
} from '@convex/lib/runLease';
import {
	ensureAssistantToolPartsFromJobs,
	joinAssistantTextParts,
	resolveAssistantMessageText,
	type AssistantPart
} from '@convex/lib/assistantParts';
import {
	classifyCompletionStreamBatch,
	type CompletionStreamBatchClassification,
	vCompletionStreamEvent
} from '@convex/lib/completionStream';
import {
	type AgentHistoryMessage,
	isRunFinalStatus,
	vExecutorJobKind,
	vExecutorJobPayload,
	vModelId,
	vReasoningEffort,
	vRunFinalStatus,
	vRunStatus
} from '@convex/lib/validators';

type FinalizeRunArgs = {
	text: string;
	status: Infer<typeof vRunFinalStatus>;
	lastError?: string;
};

async function finalizeRunRecord(
	ctx: MutationCtx,
	userId: string,
	run: Doc<'runs'>,
	args: FinalizeRunArgs
): Promise<boolean> {
	const alreadyFinal = isRunFinalStatus(run.status);
	const finalStatus = alreadyFinal ? run.status : args.status;
	const completedAt = run.completedAt ?? Date.now();
	const jobs: Doc<'executorJobs'>[] = await ctx.db
		.query('executorJobs')
		.withIndex('by_runId_sequence', (query) => query.eq('runId', run._id))
		.collect();
	const finalizedJobs = cancelExecutorJobsForTerminalRun({
		jobs,
		runStatus: finalStatus,
		lastError: alreadyFinal ? run.lastError : args.lastError,
		completedAt
	});
	for (const [index, job] of jobs.entries()) {
		const finalizedJob = finalizedJobs[index];
		if (finalizedJob === job) continue;
		await ctx.db.patch(job._id, {
			status: finalizedJob.status,
			error: finalizedJob.error,
			completedAt: finalizedJob.completedAt
		});
	}
	if (alreadyFinal) {
		if (run.activeJobId) {
			await ctx.db.patch(run._id, { activeJobId: undefined });
		}
		return true;
	}

	const responseMessageId =
		run.responseMessageId ??
		(await appendThreadMessage(ctx, {
			threadId: run.threadId,
			runId: run._id,
			userId,
			type: 'response',
			text: ''
		}));
	const message = run.responseMessageId
		? await getThreadMessage(ctx, run.responseMessageId)
		: undefined;

	const persistedParts = (message?.parts ?? []) as AssistantPart[];
	const nextParts: AssistantPart[] = ensureAssistantToolPartsFromJobs(
		persistedParts,
		finalizedJobs
			.filter((job) => !job.hidden)
			.sort((left, right) => left.sequence - right.sequence)
			.map((job) => ({
				id: job._id,
				kind: job.kind,
				...(job.callId ? { callId: job.callId } : {}),
				payload: job.payload,
				status: job.status,
				result: job.result,
				error: job.error
			}))
	);
	const streamedText: string = joinAssistantTextParts(nextParts);
	await ctx.db.patch(responseMessageId, {
		text: resolveAssistantMessageText(streamedText, args.text),
		parts: nextParts
	});
	await ctx.db.patch(run._id, {
		status: finalStatus,
		claimExpiresAt: undefined,
		lastError: args.lastError,
		activeJobId: undefined,
		completedAt,
		responseMessageId
	});
	return true;
}

export const createRun = mutation({
	args: {
		submissionId: v.string(),
		threadId: v.id('threadRecords'),
		prompt: v.string(),
		selectedModel: vModelId,
		reasoningEffort: vReasoningEffort
	},
	handler: async (
		ctx,
		args
	): Promise<{
		created: boolean;
		runId: Id<'runs'>;
		promptMessageId: Id<'threadMessages'>;
	}> => {
		const userId: string = await getUserId(ctx);
		const threadRecord: Doc<'threadRecords'> = await getOwnedThreadRecord(
			ctx.db,
			userId,
			args.threadId
		);
		const prompt: string = args.prompt.trim();
		if (!prompt) {
			throw new Error('Prompt cannot be empty.');
		}

		const existingRun: Doc<'runs'> | null = await ctx.db
			.query('runs')
			.withIndex('by_userId_submissionId', (query) =>
				query.eq('userId', userId).eq('submissionId', args.submissionId)
			)
			.unique();
		if (existingRun) {
			if (
				existingRun.threadId !== args.threadId ||
				existingRun.selectedModel !== args.selectedModel ||
				existingRun.reasoningEffort !== args.reasoningEffort ||
				!existingRun.promptMessageId
			) {
				throw new Error('Submission belongs to a different or incomplete run.');
			}
			const existingPrompt = await ctx.db.get(existingRun.promptMessageId);
			if (!existingPrompt || existingPrompt.text !== prompt) {
				throw new Error('Submission prompt does not match the existing run.');
			}

			return {
				created: false,
				runId: existingRun._id,
				promptMessageId: existingRun.promptMessageId
			};
		}
		const latestRun: Doc<'runs'> | null = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', args.threadId))
			.order('desc')
			.first();
		assertThreadCanStartRun(latestRun?.status);

		const runId: Id<'runs'> = await ctx.db.insert('runs', {
			threadId: args.threadId,
			userId,
			submissionId: args.submissionId,
			workspaceSessionId: threadRecord.workspaceSessionId,
			status: 'queued',
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			startedAt: Date.now()
		});
		const promptMessageId: Id<'threadMessages'> = await appendThreadMessage(ctx, {
			threadId: args.threadId,
			runId,
			userId,
			type: 'prompt',
			text: prompt
		});
		await ctx.db.patch(runId, {
			promptMessageId
		});
		await ctx.db.patch(threadRecord._id, {
			title: threadRecord.title ?? prompt.slice(0, 72),
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort
		});

		return {
			created: true,
			runId,
			promptMessageId
		};
	}
});

export const start = mutation({
	args: {
		claimId: v.string(),
		runId: v.id('runs')
	},
	handler: async (ctx, args): Promise<{ claimed: boolean; claimExpiresAt?: number }> => {
		const userId: string = await getUserId(ctx);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		const now = Date.now();
		if (!canStartRunWithClaim(run, args.claimId, now)) {
			return { claimed: false };
		}

		const isTakeover = isClaimedRunStatus(run.status) && run.claimId !== args.claimId;
		const isSameClaimRenewal = isClaimedRunStatus(run.status) && run.claimId === args.claimId;
		if (isTakeover && run.activeJobId) {
			const activeJob = await ctx.db.get(run.activeJobId);
			if (activeJob && (activeJob.status === 'pending' || activeJob.status === 'claimed')) {
				await ctx.db.patch(activeJob._id, {
					status: 'cancelled',
					error: 'The agent worker claim expired.',
					completedAt: now
				});
			}
		}

		const nextClaimExpiresAt = claimExpiresAt(now);

		await ctx.db.patch(args.runId, {
			claimId: args.claimId,
			claimExpiresAt: nextClaimExpiresAt,
			status: isSameClaimRenewal ? run.status : 'running',
			lastError: undefined,
			...(isTakeover ? { activeJobId: undefined } : {})
		});

		return { claimed: true, claimExpiresAt: nextClaimExpiresAt };
	}
});

export const renewClaim = mutation({
	args: {
		claimId: v.string(),
		runId: v.id('runs')
	},
	handler: async (ctx, args): Promise<{ renewed: boolean; claimExpiresAt?: number }> => {
		const userId: string = await getUserId(ctx);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		if (!isClaimedRunStatus(run.status) || run.claimId !== args.claimId) {
			return { renewed: false };
		}

		const nextClaimExpiresAt = claimExpiresAt(Date.now());
		await ctx.db.patch(run._id, { claimExpiresAt: nextClaimExpiresAt });
		return { renewed: true, claimExpiresAt: nextClaimExpiresAt };
	}
});

export const getContext = query({
	args: {
		runId: v.id('runs')
	},
	handler: async (
		ctx,
		args
	): Promise<{
		run: Doc<'runs'>;
		threadRecord: Doc<'threadRecords'>;
		workspaceSession: Doc<'workspaceSessions'>;
		prompt: string;
		agentHistory: AgentHistoryMessage[];
	}> => {
		const userId: string = await getUserId(ctx);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		const threadRecord: Doc<'threadRecords'> = await getOwnedThreadRecord(
			ctx.db,
			userId,
			run.threadId
		);
		const workspaceSession: Doc<'workspaceSessions'> = await getOwnedWorkspaceSession(
			ctx.db,
			userId,
			run.workspaceSessionId
		);
		const messages: ThreadTranscriptMessage[] = await buildThreadTranscript(ctx, run.threadId);
		const jobs: Doc<'executorJobs'>[] = await ctx.db
			.query('executorJobs')
			.withIndex('by_threadId_sequence', (query) => query.eq('threadId', run.threadId))
			.collect();
		const agentHistory: AgentHistoryMessage[] = buildCanonicalAgentHistory({
			messages: messages.filter((message) => message.runId !== run._id),
			jobs: jobs.filter((job) => job.runId !== run._id)
		});
		const prompt: string = findLatestPrompt(messages);

		return {
			run,
			threadRecord,
			prompt,
			agentHistory,
			workspaceSession
		};
	}
});

export const isFinished = query({
	args: {
		runId: v.id('runs')
	},
	handler: async (ctx, args): Promise<boolean> => {
		const userId: string = await getUserId(ctx);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		return isRunFinalStatus(run.status);
	}
});

export const completionActor = query({
	args: {
		runId: v.id('runs')
	},
	handler: async (
		ctx,
		args
	): Promise<{
		userId: string;
		status: Infer<typeof vRunStatus>;
		streamSequence: number;
		streamAttemptId?: string;
	}> => {
		const userId: string = await getUserId(ctx);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		const message = run.responseMessageId
			? await getThreadMessage(ctx, run.responseMessageId)
			: null;
		return {
			userId,
			status: run.status,
			streamSequence: message?.streamSequence ?? 0,
			...(message?.streamAttemptId ? { streamAttemptId: message.streamAttemptId } : {})
		};
	}
});

export const beginAssistantMessage = mutation({
	args: {
		runId: v.id('runs')
	},
	handler: async (ctx, args): Promise<void> => {
		const userId: string = await getUserId(ctx);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		if (isRunFinalStatus(run.status)) {
			return;
		}
		const assistantMessage: Doc<'threadMessages'> | null = run.responseMessageId
			? await ctx.db.get(run.responseMessageId)
			: null;
		if (assistantMessage) {
			return;
		}

		const messageId: Id<'threadMessages'> = await appendThreadMessage(ctx, {
			threadId: run.threadId,
			runId: args.runId,
			userId,
			type: 'response',
			text: ''
		});
		await ctx.db.patch(args.runId, {
			responseMessageId: messageId
		});
	}
});

export const mergeAssistantStreamEvents = mutation({
	args: {
		runId: v.id('runs'),
		streamId: v.string(),
		sequence: v.number(),
		events: v.array(vCompletionStreamEvent)
	},
	handler: async (
		ctx,
		args
	): Promise<Exclude<CompletionStreamBatchClassification, 'append'> | 'merged'> => {
		const userId: string = await getUserId(ctx);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		assertRunAcceptsModelCompletion(run.status);
		if (!run.responseMessageId || args.events.length === 0) {
			return 'merged';
		}

		const message: Doc<'threadMessages'> = await getThreadMessage(ctx, run.responseMessageId);
		const lastSequence = message.streamSequence ?? 0;
		const classification = classifyCompletionStreamBatch({
			lastSequence,
			lastStreamId: message.streamAttemptId,
			sequence: args.sequence,
			streamId: args.streamId
		});
		if (classification !== 'append') {
			return classification;
		}
		const parts: AssistantPart[] = [...((message.parts ?? []) as AssistantPart[])];
		const textIndexById = new Map<string, number>();
		const toolIndexByCallId = new Map<string, number>();
		for (const [index, part] of parts.entries()) {
			if (part.type === 'text' || part.type === 'reasoning') {
				textIndexById.set(`${part.type}:${part.id}`, index);
			} else if (part.type === 'tool-call') {
				toolIndexByCallId.set(part.partId ?? part.callId, index);
			}
		}

		for (const event of args.events) {
			if (event.type === 'text' || event.type === 'reasoning') {
				const key = `${event.type}:${event.id}`;
				const index = textIndexById.get(key);
				if (index === undefined) {
					const nextPart: AssistantPart =
						event.type === 'reasoning'
							? {
									type: 'reasoning',
									id: event.id,
									text: event.text,
									...(event.turnId ? { turnId: event.turnId } : {}),
									...(event.providerMetadata !== undefined
										? { providerMetadata: event.providerMetadata }
										: {})
								}
							: {
									type: 'text',
									id: event.id,
									text: event.text,
									...(event.turnId ? { turnId: event.turnId } : {}),
									...(event.providerMetadata !== undefined
										? { providerMetadata: event.providerMetadata }
										: {})
								};
					textIndexById.set(key, parts.push(nextPart) - 1);
					continue;
				}
				const existing = parts[index];
				if (existing.type === event.type) {
					existing.text += event.text;
					if (event.turnId) existing.turnId = event.turnId;
					if (event.providerMetadata !== undefined) {
						existing.providerMetadata = event.providerMetadata;
					}
				}
				continue;
			}

			const index = toolIndexByCallId.get(event.partId);
			const toolPart: AssistantPart = {
				type: 'tool-call',
				partId: event.partId,
				callId: event.callId,
				name: event.name,
				input: event.input,
				...(event.turnId ? { turnId: event.turnId } : {}),
				...(event.providerMetadata !== undefined
					? { providerMetadata: event.providerMetadata }
					: {})
			};
			if (index === undefined) {
				toolIndexByCallId.set(event.partId, parts.push(toolPart) - 1);
			} else {
				parts[index] = toolPart;
			}
		}

		await ctx.db.patch(run.responseMessageId, {
			text: joinAssistantTextParts(parts),
			parts,
			streamSequence: args.sequence,
			streamAttemptId: args.streamId
		});
		return 'merged';
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
	handler: async (ctx, args): Promise<boolean> => {
		const userId: string = await getUserId(ctx);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		if (args.expectedStatus && run.status !== args.expectedStatus) {
			return false;
		}
		if (
			args.expectedClaimId &&
			(run.claimId !== args.expectedClaimId || !isRunClaimLeaseActive(run, Date.now()))
		) {
			return false;
		}
		return finalizeRunRecord(ctx, userId, run, args);
	}
});

export const finalizeFailedStart = mutation({
	args: {
		submissionId: v.string(),
		threadId: v.id('threadRecords'),
		prompt: v.string(),
		selectedModel: vModelId,
		reasoningEffort: vReasoningEffort,
		text: v.string(),
		lastError: v.string()
	},
	handler: async (ctx, args): Promise<boolean> => {
		const userId: string = await getUserId(ctx);
		const run: Doc<'runs'> | null = await ctx.db
			.query('runs')
			.withIndex('by_userId_submissionId', (query) =>
				query.eq('userId', userId).eq('submissionId', args.submissionId)
			)
			.unique();
		if (
			!run ||
			run.status !== 'queued' ||
			run.threadId !== args.threadId ||
			run.selectedModel !== args.selectedModel ||
			run.reasoningEffort !== args.reasoningEffort ||
			!run.promptMessageId
		) {
			return false;
		}
		const promptMessage = await ctx.db.get(run.promptMessageId);
		if (!promptMessage || promptMessage.text !== args.prompt.trim()) {
			return false;
		}
		return finalizeRunRecord(ctx, userId, run, {
			text: args.text,
			status: 'failed',
			lastError: args.lastError
		});
	}
});

export const finalizeClaimFailure = mutation({
	args: {
		claimId: v.string(),
		runId: v.id('runs'),
		text: v.string(),
		lastError: v.string()
	},
	handler: async (ctx, args): Promise<boolean> => {
		const userId: string = await getUserId(ctx);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
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
		hidden: v.optional(v.boolean())
	},
	handler: async (
		ctx,
		args
	): Promise<{
		jobId: Id<'executorJobs'>;
		sequence: number;
	}> => {
		const userId: string = await getUserId(ctx);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		assertRunAcceptsModelCompletion(run.status);
		if (run.claimId !== args.claimId || !isRunClaimLeaseActive(run, Date.now())) {
			throw new Error('Run is no longer active.');
		}
		const workspaceSession: Doc<'workspaceSessions'> = await getOwnedWorkspaceSession(
			ctx.db,
			userId,
			run.workspaceSessionId
		);

		const nextSequence: number = workspaceSession.nextExecutorSequence ?? 0;
		await ctx.db.patch(workspaceSession._id, {
			nextExecutorSequence: nextSequence + 1
		});

		const jobId: Id<'executorJobs'> = await ctx.db.insert('executorJobs', {
			workspaceSessionId: run.workspaceSessionId,
			threadId: run.threadId,
			runId: args.runId,
			kind: args.kind,
			...(args.callId ? { callId: args.callId } : {}),
			payload: args.payload,
			hidden: args.hidden ?? false,
			status: 'claimed',
			enqueuedAt: Date.now(),
			claimedAt: Date.now(),
			sequence: nextSequence
		});

		await ctx.db.patch(args.runId, {
			status: 'awaiting_executor',
			activeJobId: jobId
		});

		return {
			jobId,
			sequence: nextSequence
		};
	}
});
