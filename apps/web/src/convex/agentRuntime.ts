import type { Doc, Id } from '@convex/_generated/dataModel';
import { mutation, query, type MutationCtx, type QueryCtx } from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';
import { getOwnedRun, getOwnedThreadRecord, getOwnedProject } from '@convex/lib/access';
import { executionSecretHash, getExecutionRun, getUserId } from '@convex/lib/auth';
import { getModelDefinition } from '@convex/lib/models';
import { assertModelConfigurationAllowedForUser } from '@convex/lib/tiers';
import { buildCanonicalAgentHistory } from '@convex/lib/agentHistory';
import { contextSummaryText } from '@convex/lib/contextCompaction';
import {
	vCompletionActor,
	vCompletionStreamMergeResult,
	vGetContextResult
} from '@convex/lib/docs';
import { appendThreadMessage, getThreadMessage } from '@convex/lib/threadMessages';
import { recordThreadUsage } from '@convex/lib/threadUsage';
import {
	areImageUploadIdsEqual,
	attachImageUploads,
	getOwnedImageUploads
} from '@convex/lib/imageUploads';
import { buildThreadTranscript } from '@convex/lib/threadTranscript';
import { RUN_NO_LONGER_ACTIVE, assertRunAcceptsModelCompletion } from '@convex/lib/agentErrors';
import {
	assertThreadCanStartRun,
	cancelExecutorJobsForTerminalRun,
	compareRunStartedAt
} from '@convex/lib/runs';
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
import {
	ensureAssistantToolPartsFromJobs,
	joinAssistantTextParts,
	toPersistableExecutorToolJobs,
	type AssistantPart
} from '@convex/lib/assistantParts';
import {
	COMPLETION_STREAM_SUPERSEDED,
	classifyCompletionStreamBatch,
	vCompletionStreamEvent
} from '@convex/lib/completionStream';
import {
	isRunFinalStatus,
	vExecutorJobKind,
	vExecutorJobPayload,
	vModelId,
	vReasoningEffort,
	vServiceTier,
	vRunFinalStatus,
	vRunStatus
} from '@convex/lib/validators';

type FinalizeRunArgs = {
	text: string;
	status: Infer<typeof vRunFinalStatus>;
	lastError?: string;
};

type FinalizeExpectationArgs = {
	expectedStatus?: Infer<typeof vRunStatus>;
	expectedClaimId?: string;
};

async function getCompletionStreamState(
	ctx: MutationCtx | QueryCtx,
	run: Doc<'runs'>
): Promise<Doc<'completionStreamStates'>> {
	if (!run.completionStreamStateId) {
		throw new Error('Run does not contain completion stream state.');
	}
	const state = await ctx.db.get(run.completionStreamStateId);
	if (!state || state.runId !== run._id || state.userId !== run.userId) {
		throw new Error('Completion stream state is invalid.');
	}
	return state;
}

function matchesFinalizeExpectations(run: Doc<'runs'>, args: FinalizeExpectationArgs): boolean {
	if (args.expectedStatus && run.status !== args.expectedStatus) {
		return false;
	}
	if (
		args.expectedClaimId &&
		(run.claimId !== args.expectedClaimId || !isRunClaimLeaseActive(run, Date.now()))
	) {
		return false;
	}
	return true;
}

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
	const pendingQuestions = await ctx.db
		.query('agentQuestions')
		.withIndex('by_runId_sequence', (query) => query.eq('runId', run._id))
		.collect();
	for (const question of pendingQuestions) {
		if (question.status === 'pending') {
			await ctx.db.patch(question._id, {
				status: 'cancelled',
				answeredAt: completedAt
			});
		}
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

	const persistedParts = message?.parts ?? [];
	const nextParts: AssistantPart[] = ensureAssistantToolPartsFromJobs(
		persistedParts,
		toPersistableExecutorToolJobs(finalizedJobs)
	);
	const streamedText: string = joinAssistantTextParts(nextParts);
	await ctx.db.patch(responseMessageId, {
		text: streamedText || args.text,
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
		imageUploadIds: v.array(v.id('imageUploads')),
		selectedModel: vModelId,
		reasoningEffort: vReasoningEffort,
		serviceTier: vServiceTier,
		executionSecret: v.string()
	},
	returns: v.object({
		created: v.boolean(),
		runId: v.id('runs'),
		promptMessageId: v.id('threadMessages')
	}),
	// Also terminalizes a previous claimed run whose lease lapsed — it was
	// abandoned by its executor and would block every later submission.
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		await assertModelConfigurationAllowedForUser(ctx, userId, {
			modelId: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			serviceTier: args.serviceTier
		});
		const secretHash = await executionSecretHash(args.executionSecret);
		const threadRecord = await getOwnedThreadRecord(ctx.db, userId, args.threadId);
		const prompt = args.prompt.trim();
		if (!prompt && args.imageUploadIds.length === 0) {
			throw new Error('Message cannot be empty.');
		}
		const imageUploads = await getOwnedImageUploads(ctx, userId, args.imageUploadIds);

		const existingRun = await ctx.db
			.query('runs')
			.withIndex('by_userId_submissionId', (query) =>
				query.eq('userId', userId).eq('submissionId', args.submissionId)
			)
			.unique();
		if (existingRun) {
			if (existingRun.executionSecretHash !== secretHash) {
				const canRecoverExecutor =
					existingRun.status === 'queued' ||
					(isClaimedRunStatus(existingRun.status) &&
						!isRunClaimLeaseActive(existingRun, Date.now()));
				if (!canRecoverExecutor) {
					throw new Error('Submission belongs to a different active executor.');
				}
				await ctx.db.patch(existingRun._id, { executionSecretHash: secretHash });
			}
			if (
				existingRun.threadId !== args.threadId ||
				existingRun.selectedModel !== args.selectedModel ||
				existingRun.reasoningEffort !== args.reasoningEffort ||
				existingRun.serviceTier !== args.serviceTier ||
				!existingRun.promptMessageId ||
				!existingRun.completionStreamStateId
			) {
				throw new Error('Submission belongs to a different or incomplete run.');
			}
			const existingPrompt = await ctx.db.get(existingRun.promptMessageId);
			if (
				!existingPrompt ||
				existingPrompt.text !== prompt ||
				!areImageUploadIdsEqual(existingPrompt.imageUploadIds, args.imageUploadIds)
			) {
				throw new Error('Submission prompt does not match the existing run.');
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
			await finalizeRunRecord(ctx, userId, latestRun, {
				text: 'Run aborted: The local agent stopped responding before this run finished.',
				status: 'failed',
				lastError: 'The local agent stopped responding before this run finished.'
			});
		} else {
			assertThreadCanStartRun(latestRun?.status);
		}

		const runId = await ctx.db.insert('runs', {
			threadId: args.threadId,
			userId,
			submissionId: args.submissionId,
			projectId: threadRecord.projectId,
			status: 'queued',
			executionSecretHash: secretHash,
			completionAttemptSeq: 0,
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			serviceTier: args.serviceTier,
			startedAt: Date.now()
		});
		const completionStreamStateId = await ctx.db.insert('completionStreamStates', {
			runId,
			userId,
			sequence: 0
		});
		const promptMessageId = await appendThreadMessage(ctx, {
			threadId: args.threadId,
			runId,
			userId,
			type: 'prompt',
			text: prompt,
			imageUploadIds: args.imageUploadIds
		});
		await attachImageUploads(ctx, imageUploads, promptMessageId);
		await ctx.db.patch(runId, {
			promptMessageId,
			completionStreamStateId
		});
		await ctx.db.patch(threadRecord._id, {
			title: threadRecord.title ?? (prompt || imageUploads[0]?.name || 'New thread').slice(0, 72),
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			serviceTier: args.serviceTier
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
		// Takeover restarts from the prompt. Cancel/hide only in-flight jobs so
		// completed side effects stay visible; clear the previous claim's
		// partial response so it does not duplicate into the new stream.
		if (isTakeover) {
			const staleJobs = await ctx.db
				.query('executorJobs')
				.withIndex('by_runId_sequence', (query) => query.eq('runId', args.runId))
				.collect();
			for (const job of staleJobs) {
				const isFinal =
					job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
				if (isFinal) {
					continue;
				}
				await ctx.db.patch(job._id, {
					hidden: true,
					status: 'cancelled',
					error: 'The agent worker claim expired.',
					completedAt: now
				});
			}
			if (run.responseMessageId) {
				await ctx.db.patch(run.responseMessageId, {
					text: '',
					parts: []
				});
			}
			const streamState = await getCompletionStreamState(ctx, run);
			await ctx.db.patch(streamState._id, {
				sequence: 0,
				streamAttemptId: undefined
			});
		}

		const nextClaimExpiresAt = claimExpiresAt(now);

		await ctx.db.patch(args.runId, {
			claimId: args.claimId,
			claimExpiresAt: nextClaimExpiresAt,
			status: isSameClaimRenewal ? run.status : 'running',
			lastError: undefined,
			...(isSameClaimRenewal ? {} : { completionAttemptSeq: 0 }),
			...(isTakeover ? { activeJobId: undefined } : {})
		});

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
		await ctx.db.patch(run._id, { claimExpiresAt: nextClaimExpiresAt });
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
		const project = await getOwnedProject(ctx.db, userId, run.projectId);
		const messages = await buildThreadTranscript(ctx, run.threadId);
		const jobs = await ctx.db
			.query('executorJobs')
			.withIndex('by_threadId_sequence', (query) => query.eq('threadId', run.threadId))
			.collect();
		let historyRunIds: Set<Id<'runs'>> | undefined;
		if (threadRecord.contextSummaryThroughRunId) {
			const runs = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', run.threadId))
				.collect();
			const ordered = runs.sort(compareRunStartedAt);
			const cutoffIndex = ordered.findIndex(
				(candidate) => candidate._id === threadRecord.contextSummaryThroughRunId
			);
			if (cutoffIndex >= 0) {
				historyRunIds = new Set(ordered.slice(cutoffIndex + 1).map((candidate) => candidate._id));
			}
		}
		const includeInHistory = (candidateRunId: Id<'runs'>) =>
			candidateRunId !== run._id && (!historyRunIds || historyRunIds.has(candidateRunId));
		const summaryHistory = threadRecord.contextSummary
			? [
					{
						role: 'user' as const,
						contents: [
							{ type: 'text' as const, text: contextSummaryText(threadRecord.contextSummary) }
						]
					}
				]
			: [];
		const agentHistory = [
			...summaryHistory,
			...buildCanonicalAgentHistory({
				messages: messages.filter((message) => includeInHistory(message.runId)),
				jobs: jobs.filter((job) => includeInHistory(job.runId))
			})
		];
		const promptMessage = messages.find(
			(message) => message.runId === run._id && message.type === 'prompt'
		);
		if (!promptMessage) {
			throw new Error('Run does not contain a user prompt.');
		}
		if ((promptMessage.imageUploadIds?.length ?? 0) !== promptMessage.attachments.length) {
			throw new Error('One or more image attachments are unavailable.');
		}
		const prompt = promptMessage.text;
		const promptAttachments = promptMessage.attachments.map(({ mediaType, url }) => ({
			mediaType,
			url
		}));
		const model = getModelDefinition(run.selectedModel);

		return {
			run,
			threadRecord,
			prompt,
			promptAttachments,
			agentHistory,
			project,
			contextBudget: {
				contextWindowTokens: model.contextWindowTokens,
				autoCompactTokenLimit: model.autoCompactTokenLimit
			}
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
		return {
			userId,
			threadId: run.threadId,
			status: run.status,
			...(run.claimId ? { claimId: run.claimId } : {}),
			...(run.claimExpiresAt ? { claimExpiresAt: run.claimExpiresAt } : {}),
			completionAttemptSeq: run.completionAttemptSeq,
			streamSequence: streamState.sequence,
			...(streamState.streamAttemptId ? { streamAttemptId: streamState.streamAttemptId } : {})
		};
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
		await recordThreadUsage(ctx, thread, { addProcessedTokens: args.processedTokens });
		let durableSummary:
			{ contextSummary: string; contextSummaryThroughRunId: Id<'runs'> } | undefined;
		if (args.persistForFutureRuns) {
			const runs = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', run.threadId))
				.collect();
			const previousRun = runs
				.filter(
					(candidate) =>
						isRunFinalStatus(candidate.status) && compareRunStartedAt(candidate, run) < 0
				)
				.sort((left, right) => compareRunStartedAt(right, left))[0];
			// Require a real cutoff run so getContext never serves a summary
			// without filtering the covered history.
			if (previousRun) {
				durableSummary = {
					contextSummary: args.summary,
					contextSummaryThroughRunId: previousRun._id
				};
			}
		}
		if (durableSummary) {
			await ctx.db.patch(thread._id, durableSummary);
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
		await recordThreadUsage(ctx, thread, {
			contextTokens: args.contextTokens,
			addProcessedTokens: args.processedTokens
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
			throw new Error(RUN_NO_LONGER_ACTIVE);
		}
		if (!canRegisterCompletionAttempt(run, args.claimId, args.attemptSeq)) {
			throw new Error(COMPLETION_STREAM_SUPERSEDED);
		}
		await ctx.db.patch(args.runId, { completionAttemptSeq: args.attemptSeq });
		// Completion turns stamp parts with turnId = streamId, so a retry can
		// drop the partial parts its prior attempts persisted.
		const supersededStreamIds = args.supersededStreamIds ?? [];
		if (supersededStreamIds.length > 0 && run.responseMessageId) {
			const superseded = new Set(supersededStreamIds);
			const message = await getThreadMessage(ctx, run.responseMessageId);
			const parts = message.parts.filter(
				(part) => !('turnId' in part && part.turnId && superseded.has(part.turnId))
			);
			if (parts.length !== message.parts.length) {
				await ctx.db.patch(run.responseMessageId, {
					text: joinAssistantTextParts(parts),
					parts
				});
			}
		}
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
		const userId = run.userId;
		if (isRunFinalStatus(run.status)) {
			return;
		}
		await getCompletionStreamState(ctx, run);
		if (run.responseMessageId) {
			return;
		}

		const messageId = await appendThreadMessage(ctx, {
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
		claimId: v.string(),
		attemptSeq: v.number(),
		streamId: v.string(),
		sequence: v.number(),
		events: v.array(vCompletionStreamEvent),
		executionSecret: v.string()
	},
	returns: vCompletionStreamMergeResult,
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		assertRunAcceptsModelCompletion(run.status);
		if (!isRunClaimLeaseActive(run, Date.now())) {
			throw new Error(RUN_NO_LONGER_ACTIVE);
		}
		// Fence every write: periodic acceptance checks alone leave a window
		// where a superseded attempt could still append after a newer one registers.
		if (!isCurrentCompletionAttempt(run, args.claimId, args.attemptSeq)) {
			return 'superseded';
		}
		if (!run.responseMessageId || args.events.length === 0) {
			return 'merged';
		}

		const streamState = await getCompletionStreamState(ctx, run);
		const message = await getThreadMessage(ctx, run.responseMessageId);
		const classification = classifyCompletionStreamBatch({
			lastSequence: streamState.sequence,
			lastStreamId: streamState.streamAttemptId,
			sequence: args.sequence,
			streamId: args.streamId
		});
		if (classification !== 'append') {
			return classification;
		}
		const parts = [...message.parts];
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
			parts
		});
		await ctx.db.patch(streamState._id, {
			sequence: args.sequence,
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
		selectedModel: vModelId,
		reasoningEffort: vReasoningEffort,
		serviceTier: vServiceTier,
		text: v.string(),
		lastError: v.string(),
		executionSecret: v.string()
	},
	// `finalized`: the queued run was terminalized. `pending`: no run is
	// visible yet for the capability; the caller should retry while createRun
	// may still be in flight. `observed`: the run already belongs to an active
	// executor (a racing launch rebound it) or is past the queued stage, so
	// the caller must stand down without terminalizing it.
	returns: v.union(v.literal('finalized'), v.literal('pending'), v.literal('observed')),
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
			// secret; tell the loser to stand down instead of retrying forever.
			if (ctx.auth.getUserIdentity() !== null) {
				const userId = await getUserId(ctx);
				const submittedRun = await ctx.db
					.query('runs')
					.withIndex('by_userId_submissionId', (query) =>
						query.eq('userId', userId).eq('submissionId', args.submissionId)
					)
					.unique();
				if (submittedRun) {
					return 'observed';
				}
			}
			return 'pending';
		}
		if (run.status !== 'queued' || run.executionSecretHash !== secretHash) {
			return 'observed';
		}
		if (
			run.threadId !== args.threadId ||
			run.selectedModel !== args.selectedModel ||
			run.reasoningEffort !== args.reasoningEffort ||
			run.serviceTier !== args.serviceTier ||
			!run.promptMessageId
		) {
			return 'observed';
		}
		const promptMessage = await ctx.db.get(run.promptMessageId);
		if (
			!promptMessage ||
			promptMessage.text !== args.prompt.trim() ||
			!areImageUploadIdsEqual(promptMessage.imageUploadIds, args.imageUploadIds)
		) {
			return 'observed';
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
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		const userId = run.userId;
		assertRunAcceptsModelCompletion(run.status);
		if (run.claimId !== args.claimId || !isRunClaimLeaseActive(run, Date.now())) {
			throw new Error('Run is no longer active.');
		}
		const project = await getOwnedProject(ctx.db, userId, run.projectId);

		const nextSequence = project.nextExecutorSequence;
		await ctx.db.patch(project._id, {
			nextExecutorSequence: nextSequence + 1
		});

		const jobId = await ctx.db.insert('executorJobs', {
			projectId: run.projectId,
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
