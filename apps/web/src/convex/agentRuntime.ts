import { action, internalMutation, mutation, query } from '@convex/_generated/server';
import type { Doc } from '@convex/_generated/dataModel';
import { internal } from '@convex/_generated/api';
import schema from '@convex/schema';
import { ConvexError, v, type Infer } from 'convex/values';
import { getOwnedRun, getOwnedThreadRecord } from '@convex/lib/access';
import { getExecutionRun, getExecutionRunRecord, getUserId } from '@convex/lib/auth';
import { patchRunExecution } from '@convex/lib/runExecution';
import { GATEWAY_PROTOCOL_VERSION } from '@convex/lib/gatewayProtocol';
import { modelGatewayTokenSecret, modelGatewayUrl } from '@convex/lib/gatewayFetch';
import { gatewayTokenExpiresAt, mintGatewayToken } from '@convex/lib/gatewayToken';
import { vCompletionActor, vGetContextResult } from '@convex/lib/docs';
import {
	contextHandoffKey,
	existingThroughPartNumber,
	throughPartNumberForHandoff
} from '@convex/lib/contextHandoff';
import {
	clearThreadContextTokens,
	getThreadContextTokens,
	recordThreadUsageEvent,
	usageEventId
} from '@convex/lib/threadUsage';
import {
	executorFinalizationResult,
	finalizeRunRecord,
	matchesFinalizeExpectations,
	vExecutorFinalizationResult
} from '@convex/lib/runFinalize';
import { requestRunCancellation } from './runLifecycle';
import {
	recordCompletionTranscript,
	recordSettledToolTranscripts
} from '@convex/lib/transcriptWrites';
import {
	COMPLETION_STREAM_SUPERSEDED,
	RUN_NO_LONGER_ACTIVE,
	assertRunAcceptsModelCompletion,
	toAgentToolConvexError
} from '@convex/lib/agentErrors';
import { unsupportedClient } from '@convex/lib/unsupportedClient';
import { setRunAndThreadStatus } from '@convex/lib/threadRunStatus';
import {
	createQueuedRunRecord,
	finalizeFailedQueuedStart,
	type QueuedRunRequest
} from '@convex/lib/runCreate';
import { beginExecutorJob } from '@convex/lib/toolJobs';
import { sectionOrder, workMembership } from '@convex/lib/workSections';
import { getPromptPart, stripLegacyAttachmentImageUploadIds } from '@convex/lib/transcriptParts';
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
	isRunFinalStatus,
	vCurrentExecutorJobKind,
	vCurrentExecutorJobPayload,
	vReasoningEffort,
	vRunFinalStatus,
	vRunStatus,
	vTranscriptCompletionItem
} from '@convex/lib/validators';

type RunClaimPatch = {
	claimId: string;
	claimExpiresAt: number;
	completionAttemptSeq?: number;
};

function isExpectedSectionKey(
	runId: Doc<'runs'>['_id'],
	claimId: string,
	attemptSeq: number,
	sectionKey: string,
	sectionOrdinal: number
) {
	const prefix = `agent:${runId}:${claimId}:`;
	const suffix = `:section:${sectionOrdinal}`;
	if (!sectionKey.startsWith(prefix) || !sectionKey.endsWith(suffix)) return false;
	const sectionAttempt = Number(sectionKey.slice(prefix.length, -suffix.length));
	return (
		Number.isSafeInteger(sectionAttempt) && sectionAttempt >= 0 && sectionAttempt <= attemptSeq
	);
}

const MAX_COMPLETION_ASSIGNMENTS = 256;

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
		fastMode: v.boolean(),
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
		transcriptProtocol: v.optional(v.literal(2)),
		submissionId: v.string(),
		threadId: v.optional(v.id('threadRecords')),
		repositoryKey: v.optional(v.string()),
		prompt: v.string(),
		storageIds: v.array(v.id('_storage')),
		selectedModel: v.string(),
		reasoningEffort: vReasoningEffort,
		fastMode: v.boolean(),
		executionSecret: v.string(),
		agentVersion: v.optional(v.string()),
		machineId: v.optional(v.string()),
		continuationOfRunId: v.optional(v.id('runs'))
	},
	returns: vCreateGatewayRunResult,
	handler: async (ctx, args): Promise<Infer<typeof vCreateGatewayRunResult>> => {
		if (args.transcriptProtocol !== 2) unsupportedClient();
		const userId = await getUserId(ctx);
		const imageUploadIds = await ctx.runQuery(internal.imageUploads.ownedIdsForStorageIds, {
			userId,
			storageIds: args.storageIds
		});
		const gatewayUrl = modelGatewayUrl();
		const request: QueuedRunRequest = {
			userId,
			submissionId: args.submissionId,
			threadId: args.threadId,
			repositoryKey: args.repositoryKey,
			prompt: args.prompt,
			imageUploadIds,
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			fastMode: args.fastMode,
			executionSecret: args.executionSecret,
			protocolVersion: GATEWAY_PROTOCOL_VERSION,
			agentVersion: args.agentVersion,
			machineId: args.machineId
		};
		if (args.continuationOfRunId) request.continuationOfRunId = args.continuationOfRunId;
		const created = await ctx.runMutation(internal.agentRuntime.insertGatewayRun, request);
		if (created.promptPart) {
			created.promptPart = stripLegacyAttachmentImageUploadIds([created.promptPart])[0];
		}
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
			claimExpiresAt: nextClaimExpiresAt
		};
		if (!isSameClaimRenewal) claimPatch.completionAttemptSeq = 0;
		await patchRunExecution(ctx, run._id, claimPatch);
		await setRunAndThreadStatus(ctx, run, 'running', { lastError: undefined });

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
		await patchRunExecution(ctx, run._id, { claimExpiresAt: nextClaimExpiresAt });
		return { renewed: true, claimExpiresAt: nextClaimExpiresAt };
	}
});

function getContextResult(args: {
	run: Doc<'runs'>;
	prompt: string;
	contextTokens: number | undefined;
}): Infer<typeof vGetContextResult> {
	const result: Infer<typeof vGetContextResult> = {
		run: {
			_id: args.run._id,
			threadId: args.run.threadId,
			userId: args.run.userId,
			selectedModel: args.run.selectedModel,
			reasoningEffort: args.run.reasoningEffort,
			fastMode: args.run.fastMode,
			startedAt: args.run.startedAt,
			continuationOfRunId: args.run.continuationOfRunId
		},
		prompt: args.prompt
	};
	if (args.contextTokens !== undefined) {
		result.contextTokens = args.contextTokens;
	}
	return result;
}

export const getContext = query({
	args: {
		runId: v.id('runs'),
		executionSecret: v.string()
	},
	returns: vGetContextResult,
	handler: async (ctx, args) => {
		const run = await getExecutionRunRecord(ctx, args.runId, args.executionSecret);
		const contextTokens = await getThreadContextTokens(ctx, run.threadId);
		const promptPart = await getPromptPart(ctx, run.threadId, run._id);
		if (!promptPart?.prompt) {
			if (!run.continuationOfRunId) {
				throw new Error('Run does not contain a user prompt.');
			}
			return getContextResult({
				run,
				prompt: '',
				contextTokens
			});
		}
		return getContextResult({
			run,
			prompt: promptPart.prompt.text,
			contextTokens
		});
	}
});

export const isFinished = query({
	args: {
		runId: v.id('runs'),
		executionSecret: v.string()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await getExecutionRunRecord(ctx, args.runId, args.executionSecret);
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
		const actor: Infer<typeof vCompletionActor> = {
			userId,
			threadId: run.threadId,
			status: run.status
		};
		if (run.claimId) actor.claimId = run.claimId;
		if (run.claimExpiresAt) actor.claimExpiresAt = run.claimExpiresAt;
		return actor;
	}
});

/** Retired run-scoped compaction API. Current agents save part-bounded handoffs. */
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
	handler: async () => {
		unsupportedClient();
	}
});

/** Persist the hidden handoff after all covered visible parts have been finalized. */
export const saveContextHandoff = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		summary: v.string(),
		completionAttemptSeq: v.number(),
		beforePrompt: v.boolean()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		if (!ownsActiveRunClaim(run, args.claimId, Date.now())) return false;
		if (!isCurrentCompletionAttempt(run, args.claimId, args.completionAttemptSeq)) {
			return false;
		}
		if (!args.summary.trim()) {
			throw new Error('Invalid context handoff.');
		}
		const thread = await getOwnedThreadRecord(ctx.db, run.userId, run.threadId);
		const throughPartNumber = await throughPartNumberForHandoff(ctx, {
			threadId: run.threadId,
			runId: run._id,
			beforePrompt: args.beforePrompt
		});
		const handoffKey = contextHandoffKey(run._id, args.claimId, args.completionAttemptSeq);
		const existingCutoff = await existingThroughPartNumber(ctx, thread);
		if (thread.contextSummaryHandoffKey === handoffKey) {
			if (existingCutoff !== undefined && throughPartNumber < existingCutoff) {
				throw new Error('Invalid context handoff cutoff.');
			}
			if (thread.contextSummary !== args.summary) {
				throw new Error('Conflicting context handoff retry.');
			}
			return true;
		}
		if (existingCutoff !== undefined && throughPartNumber < existingCutoff) {
			throw new Error('Invalid context handoff cutoff.');
		}
		await ctx.db.patch('threadRecords', thread._id, {
			contextSummary: args.summary,
			contextSummaryThroughPartNumber: throughPartNumber,
			contextSummaryThroughRunId: undefined,
			contextSummaryHandoffKey: handoffKey
		});
		await clearThreadContextTokens(ctx, thread._id);
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
		await patchRunExecution(ctx, run._id, { completionAttemptSeq: args.attemptSeq });
	}
});

export const finalizeCompletionCall = mutation({
	args: {
		transcriptProtocol: v.optional(v.literal(2)),
		runId: v.id('runs'),
		claimId: v.string(),
		attemptSeq: v.number(),
		streamId: v.string(),
		items: v.array(vTranscriptCompletionItem),
		work: workMembership,
		toolInvocations: v.array(
			v.object({
				callId: v.string(),
				toolInvocationId: v.string(),
				sectionKey: v.optional(v.string())
			})
		),
		sections: v.array(sectionOrder),
		executionSecret: v.string()
	},
	returns: v.union(schema.doc('threadTranscriptParts'), v.null()),
	handler: async (ctx, args) => {
		if (args.transcriptProtocol !== 2) unsupportedClient();
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		assertRunAcceptsModelCompletion(run);
		if (!isRunClaimLeaseActive(run, Date.now())) {
			throw new ConvexError(RUN_NO_LONGER_ACTIVE);
		}
		if (!isCurrentCompletionAttempt(run, args.claimId, args.attemptSeq)) {
			return null;
		}
		const sectionOrdinals = new Map(
			args.sections.map((section) => [section.sectionKey, section.sectionOrdinal])
		);
		if (
			args.sections.length > MAX_COMPLETION_ASSIGNMENTS ||
			args.work.ranges.length > MAX_COMPLETION_ASSIGNMENTS ||
			args.toolInvocations.length > MAX_COMPLETION_ASSIGNMENTS ||
			sectionOrdinals.size !== args.sections.length ||
			args.sections.some(
				(section) =>
					!isExpectedSectionKey(
						run._id,
						args.claimId,
						args.attemptSeq,
						section.sectionKey,
						section.sectionOrdinal
					)
			)
		) {
			throw new Error('Invalid section metadata.');
		}
		const invocationIds = new Set<string>();
		for (const invocation of args.toolInvocations) {
			if (invocationIds.has(invocation.toolInvocationId)) {
				throw new Error('Duplicate tool invocation assignment.');
			}
			invocationIds.add(invocation.toolInvocationId);
			const job = await ctx.db
				.query('executorJobs')
				.withIndex('by_runId_and_toolInvocationId', (q) =>
					q.eq('runId', run._id).eq('toolInvocationId', invocation.toolInvocationId)
				)
				.unique();
			if (
				!job ||
				job.callId !== invocation.callId ||
				job.sectionKey !== invocation.sectionKey ||
				job.sectionOrdinal !==
					(invocation.sectionKey === undefined
						? job.sectionOrdinal
						: sectionOrdinals.get(invocation.sectionKey)) ||
				job.attemptSeq !== args.attemptSeq ||
				job.streamId !== args.streamId
			) {
				throw new Error('Invalid tool invocation assignment.');
			}
		}
		const completionCallIds = args.items.flatMap((item) =>
			item.type === 'tool-call' ? [item.callId] : []
		);
		if (
			completionCallIds.length !== args.toolInvocations.length ||
			completionCallIds.some((callId, index) => callId !== args.toolInvocations[index]?.callId)
		) {
			throw new Error('Incomplete tool invocation assignments.');
		}
		const invocationsByItem = new Map<number, (typeof args.toolInvocations)[number]>();
		let invocationIndex = 0;
		for (const [index, item] of args.items.entries()) {
			if (item.type === 'tool-call') {
				invocationsByItem.set(index, args.toolInvocations[invocationIndex++]);
			}
		}
		const assignedItems = new Set<number>();
		for (const range of args.work.ranges) {
			if (!sectionOrdinals.has(range.sectionKey)) throw new Error('Unknown work section.');
			for (let index = range.start; index < range.end; index++) {
				const item = args.items[index];
				if (
					!item ||
					item.type === 'text' ||
					(item.type === 'reasoning' && item.text.trim() === '') ||
					assignedItems.has(index)
				) {
					throw new Error('Invalid work assignment.');
				}
				if (item.type === 'tool-call') {
					const invocation = invocationsByItem.get(index);
					if (invocation?.sectionKey !== range.sectionKey) {
						throw new Error('Tool call assigned to a different section.');
					}
				}
				assignedItems.add(index);
			}
		}
		for (const [index, item] of args.items.entries()) {
			const invocation = invocationsByItem.get(index);
			// Empty reasoning carries only the encrypted envelope for replay and has
			// no display text. The agent tracker and read path both skip it as work,
			// so it must not carry a work range. Require work only for visible
			// reasoning and section-bound tool calls.
			const needsWork =
				(item.type === 'reasoning' && item.text.trim() !== '') ||
				invocation?.sectionKey !== undefined;
			if (needsWork) {
				if (!assignedItems.has(index)) throw new Error('Missing work assignment.');
			} else if (assignedItems.has(index)) {
				throw new Error('Non-work item has a work assignment.');
			}
		}
		const part = await recordCompletionTranscript(ctx, {
			threadId: run.threadId,
			userId: run.userId,
			runId: run._id,
			streamId: args.streamId,
			items: args.items,
			work: args.work,
			toolInvocations: args.toolInvocations,
			sections: args.sections
		});
		await recordSettledToolTranscripts(ctx, {
			threadId: run.threadId,
			userId: run.userId,
			runId: run._id,
			items: args.items,
			toolInvocations: args.toolInvocations
		});
		return part;
	}
});

/** Retired user-authenticated finalizer. Current agents use finalizeExecutorRun. */
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
	handler: async () => {
		unsupportedClient();
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
		includeOutput: v.optional(v.boolean()),
		expectedStatus: v.optional(vRunStatus),
		expectedClaimId: v.optional(v.string()),
		runId: v.id('runs'),
		text: v.string(),
		status: vRunFinalStatus,
		lastError: v.optional(v.string()),
		executionSecret: v.string()
	},
	returns: vExecutorFinalizationResult,
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		const accepted =
			matchesFinalizeExpectations(run, args) && (await finalizeRunRecord(ctx, run, args));
		return executorFinalizationResult(ctx, run, accepted, args.includeOutput);
	}
});

export const finalizeFailedStart = mutation({
	args: {
		submissionId: v.string(),
		threadId: v.optional(v.id('threadRecords')),
		prompt: v.string(),
		storageIds: v.array(v.id('_storage')),
		selectedModel: v.string(),
		reasoningEffort: vReasoningEffort,
		fastMode: v.boolean(),
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
		includeOutput: v.optional(v.boolean()),
		claimId: v.string(),
		runId: v.id('runs'),
		text: v.string(),
		lastError: v.string(),
		executionSecret: v.string()
	},
	returns: vExecutorFinalizationResult,
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		const accepted =
			canFinalizeAfterClaimFailure(run, args.claimId) &&
			(await finalizeRunRecord(ctx, run, {
				text: args.text,
				status: 'failed',
				lastError: args.lastError
			}));
		return executorFinalizationResult(ctx, run, accepted, args.includeOutput);
	}
});

export const beginToolJob = mutation({
	args: {
		claimId: v.string(),
		runId: v.id('runs'),
		kind: vCurrentExecutorJobKind,
		callId: v.optional(v.string()),
		toolInvocationId: v.string(),
		sectionKey: v.optional(v.string()),
		sectionOrdinal: v.number(),
		attemptSeq: v.number(),
		streamId: v.string(),
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
			if (!isCurrentCompletionAttempt(run, args.claimId, args.attemptSeq)) {
				throw new ConvexError(COMPLETION_STREAM_SUPERSEDED);
			}
			if (
				args.sectionKey !== undefined &&
				!isExpectedSectionKey(
					run._id,
					args.claimId,
					args.attemptSeq,
					args.sectionKey,
					args.sectionOrdinal
				)
			) {
				throw new Error('Invalid section identity.');
			}
			return await beginExecutorJob(ctx, {
				run,
				claimId: args.claimId,
				kind: args.kind,
				payload: args.payload,
				callId: args.callId,
				hidden: args.hidden,
				toolInvocationId: args.toolInvocationId,
				sectionKey: args.sectionKey,
				sectionOrdinal: args.sectionOrdinal,
				attemptSeq: args.attemptSeq,
				streamId: args.streamId
			});
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});
