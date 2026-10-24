import {
	action,
	internalMutation,
	mutation,
	query,
	type MutationCtx
} from '@convex/_generated/server';
import type { Doc } from '@convex/_generated/dataModel';
import { internal } from '@convex/_generated/api';
import schema from '@convex/schema';
import { ConvexError, v, type Infer } from 'convex/values';
import { getOwnedRun, getOwnedThreadRecord } from '@convex/lib/access';
import { getExecutionRun, getExecutionRunRecord, getUserId } from '@convex/lib/auth';
import { latestRunForThread, patchRunExecution, type ExecutionRun } from '@convex/lib/runExecution';
import { GATEWAY_PROTOCOL_VERSION } from '@convex/lib/gatewayProtocol';
import { modelGatewayTokenSecret, modelGatewayUrl } from '@convex/lib/gatewayFetch';
import { gatewayTokenExpiresAt, mintGatewayToken } from '@convex/lib/gatewayToken';
import { vCompletionActor, vGetContextResult } from '@convex/lib/docs';
import {
	contextHandoffKey,
	existingThroughPartNumber,
	getProviderHandoff,
	throughPartNumberForHandoff
} from '@convex/lib/contextHandoff';
import { getThreadContextTokens, setThreadContextTokens } from '@convex/lib/threadUsage';
import { recordModelCallUsage } from '@convex/lib/tokenUsage';
import {
	executorFinalizationResult,
	finalizeRunRecord,
	matchesFinalizeExpectations,
	vExecutorFinalizationResult
} from '@convex/lib/runFinalize';
import { requestRunCancellation, requestThreadTreeCancellation } from './runLifecycle';
import {
	recordCompletionTranscript,
	recordHiddenPrompts,
	recordPromptTranscript,
	recordSettledToolTranscripts
} from '@convex/lib/transcriptWrites';
import {
	COMPLETION_STREAM_SUPERSEDED,
	LEGACY_RUN_ABANDONED_BY_AGENT,
	RUN_ABANDONED_BY_MACHINE,
	RUN_NO_LONGER_ACTIVE,
	assertRunAcceptsModelCompletion,
	toAgentToolConvexError
} from '@convex/lib/agentErrors';
import { setRunAndThreadStatus } from '@convex/lib/threadRunStatus';
import {
	createQueuedRunRecord,
	finalizeFailedQueuedStart,
	generateTitleAfterFirstPrompt,
	submissionReadiness,
	type QueuedRunRequest
} from '@convex/lib/runCreate';
import { getUiPreferences } from '@convex/lib/uiPreferences';
import { enabledProviders } from '@convex/lib/providerOrder';
import { beginExecutorJob } from '@convex/lib/toolJobs';
import { sectionOrder, workMembership } from '@convex/lib/workSections';
import {
	getPromptPart,
	hydratePromptUrls,
	stripLegacyAttachmentImageUploadIds
} from '@convex/lib/transcriptParts';
import { runStartedAt } from '@convex/lib/runs';
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
	vCompletionProvider,
	vHiddenPrompt,
	vModelCallUsage,
	vReasoningEffort,
	vRunFinalStatus,
	vRunStatus,
	vTranscriptCompletionItem,
	type HiddenPrompt,
	type TranscriptPromptBody
} from '@convex/lib/validators';

type RunClaimPatch = {
	claimId: string;
	claimExpiresAt: number;
	completionAttemptSeq?: number;
};

const paymentToolJobKinds: ReadonlySet<string> = new Set([
	'mandate_setup',
	'mandate_status',
	'mandate_list',
	'mandate_charge',
	'mandate_report'
]);

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

export const prepareSubmission = mutation({
	args: { threadId: v.id('threadRecords') },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const thread = await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		return await submissionReadiness(ctx, thread._id);
	}
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
		completionProvider: v.optional(vCompletionProvider),
		reasoningEffort: vReasoningEffort,
		fastMode: v.boolean(),
		executionSecret: v.string(),
		agentVersion: v.optional(v.string()),
		machineId: v.optional(v.string()),
		continuationOfRunId: v.optional(v.id('runs')),
		deferPrompt: v.optional(v.boolean())
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
		storageIds: v.array(v.id('_storage')),
		selectedModel: v.string(),
		completionProvider: v.optional(vCompletionProvider),
		reasoningEffort: vReasoningEffort,
		fastMode: v.boolean(),
		executionSecret: v.string(),
		agentVersion: v.optional(v.string()),
		machineId: v.optional(v.string()),
		continuationOfRunId: v.optional(v.id('runs')),
		/** The run writes its prompt part in beginRun. Released clients omit it. */
		deferPrompt: v.optional(v.boolean())
	},
	returns: vCreateGatewayRunResult,
	handler: async (ctx, args): Promise<Infer<typeof vCreateGatewayRunResult>> => {
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
			completionProvider: args.completionProvider,
			reasoningEffort: args.reasoningEffort,
			fastMode: args.fastMode,
			executionSecret: args.executionSecret,
			agentVersion: args.agentVersion,
			machineId: args.machineId
		};

		if (args.deferPrompt) request.deferPrompt = true;

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

		if (
			run.cancellationRequestedAt !== undefined ||
			!ownsActiveRunClaim(run, args.claimId, Date.now())
		) {
			throw new ConvexError(RUN_NO_LONGER_ACTIVE);
		}

		if (
			(run.completionProvider ?? 'spikonado') !== 'spikonado' &&
			(await getProviderHandoff(ctx, run, await ctx.db.get('threadRecords', run.threadId)))
				?.completionProvider !== 'spikonado'
		) {
			throw new Error('Run is not configured to use the Spikonado gateway.');
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
	parentThreadId?: Doc<'threadRecords'>['_id'];
	prompt: string;
	pendingPrompt: TranscriptPromptBody | undefined;
	contextTokens: number | undefined;
	providerHandoff: Infer<typeof vGetContextResult>['providerHandoff'];
	providerPreferences: Infer<typeof vGetContextResult>['providerPreferences'];
	cwd: string | undefined;
	shareConversationContent: boolean;
}): Infer<typeof vGetContextResult> {
	const result: Infer<typeof vGetContextResult> = {
		run: {
			_id: args.run._id,
			threadId: args.run.threadId,
			userId: args.run.userId,
			selectedModel: args.run.selectedModel,
			completionProvider: args.run.completionProvider,
			reasoningEffort: args.run.reasoningEffort,
			fastMode: args.run.fastMode,
			startedAt: runStartedAt(args.run),
			continuationOfRunId: args.run.continuationOfRunId,
			parentThreadId: args.parentThreadId
		},
		providerPreferences: args.providerPreferences,
		prompt: args.prompt,
		shareConversationContent: args.shareConversationContent
	};

	if (args.contextTokens !== undefined) {
		result.contextTokens = args.contextTokens;
	}

	if (args.pendingPrompt !== undefined) result.pendingPrompt = args.pendingPrompt;

	if (args.providerHandoff !== undefined) result.providerHandoff = args.providerHandoff;

	if (args.cwd !== undefined) result.cwd = args.cwd;

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
		const thread = await ctx.db.get('threadRecords', run.threadId);
		const parentThreadId = thread?.parentThreadId;
		const providerHandoff = await getProviderHandoff(ctx, run, thread);
		const preferences = await getUiPreferences(ctx.db, run.userId);

		if (!promptPart?.prompt && !run.pendingPrompt && !run.continuationOfRunId) {
			throw new Error('Run does not contain a user prompt.');
		}

		return getContextResult({
			run,
			parentThreadId,
			prompt: promptPart?.prompt?.text ?? '',
			pendingPrompt: run.pendingPrompt && (await hydratePromptUrls(ctx, run.pendingPrompt)),
			contextTokens,
			providerHandoff,
			providerPreferences: {
				enabledProviders: enabledProviders(preferences?.providerOrder),
				restrictSubagentsToProvider: preferences?.restrictSubagentsToProvider ?? false
			},
			cwd: thread?.cwd,
			shareConversationContent: preferences?.shareConversationContent ?? true
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

const vHandoffSummary = {
	summary: v.string(),
	completionAttemptSeq: v.number(),
	handoffCalls: v.optional(v.array(vModelCallUsage))
};

/** Returns false when the claim or the completion attempt is no longer current. */
async function recordContextHandoff(
	ctx: MutationCtx,
	run: ExecutionRun,
	args: {
		claimId: string;
		summary: string;
		completionAttemptSeq: number;
		beforePrompt?: boolean;
		handoffCalls?: Infer<typeof vModelCallUsage>[];
		workspaceContext?: HiddenPrompt[];
	}
): Promise<boolean> {
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
		beforePrompt: args.beforePrompt ?? false
	});

	const handoffKey = contextHandoffKey(run._id, args.claimId, args.completionAttemptSeq);
	const existingCutoff = existingThroughPartNumber(thread);

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
		contextSummaryHandoffKey: handoffKey
	});

	await recordHiddenPrompts(ctx, {
		threadId: thread._id,
		runId: run._id,
		scope: handoffKey,
		prompts: args.workspaceContext ?? []
	});

	for (const [index, call] of (args.handoffCalls ?? []).entries()) {
		await recordModelCallUsage(ctx, thread, {
			runId: run._id,
			eventId: `handoff:${args.claimId}:${args.completionAttemptSeq}:${index}`,
			call
		});
	}

	await setThreadContextTokens(ctx, thread, undefined);

	return true;
}

/** Persist the hidden handoff after all covered visible parts have been finalized. */
export const saveContextHandoff = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		...vHandoffSummary,
		/** Sent by released agents; true places the cutoff before the run's prompt. */
		beforePrompt: v.optional(v.boolean()),
		/** Sent by released agents; ignored. */
		processedTokens: v.optional(v.number()),
		/** Shown after the summary; parts before the cutoff no longer reach the model. */
		workspaceContext: v.optional(v.array(vHiddenPrompt))
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);

		if (!ownsActiveRunClaim(run, args.claimId, Date.now())) return false;

		return await recordContextHandoff(ctx, run, args);
	}
});

/**
 * Writes what the model sees before the run's first call, in model order: an
 * optional handoff summary, the workspace context, then the run's prompt.
 */
export const beginRun = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		workspaceContext: v.array(vHiddenPrompt),
		handoff: v.optional(v.object(vHandoffSummary))
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);

		if (
			!ownsActiveRunClaim(run, args.claimId, Date.now()) ||
			run.cancellationRequestedAt !== undefined
		) {
			return false;
		}

		if (args.handoff) {
			const recorded = await recordContextHandoff(ctx, run, {
				...args.handoff,
				claimId: args.claimId,
				workspaceContext: args.workspaceContext
			});

			if (!recorded) return false;
		} else {
			await recordHiddenPrompts(ctx, {
				threadId: run.threadId,
				runId: run._id,
				scope: `${run._id}:${args.claimId}`,
				prompts: args.workspaceContext
			});
		}

		if (run.pendingPrompt) {
			const promptPart = await recordPromptTranscript(ctx, {
				threadId: run.threadId,
				runId: run._id,
				prompt: run.pendingPrompt
			});

			await ctx.db.patch('runs', run._id, { pendingPrompt: undefined });
			const thread = await getOwnedThreadRecord(ctx.db, run.userId, run.threadId);
			await generateTitleAfterFirstPrompt(ctx, thread, promptPart);
		}

		return true;
	}
});

export const omitReasoningReplay = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		/** Sent by released agents; true places the cutoff before the run's prompt. */
		beforePrompt: v.optional(v.boolean())
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);

		if (!ownsActiveRunClaim(run, args.claimId, Date.now())) return false;

		const thread = await getOwnedThreadRecord(ctx.db, run.userId, run.threadId);

		const throughPartNumber = await throughPartNumberForHandoff(ctx, {
			threadId: run.threadId,
			runId: run._id,
			beforePrompt: args.beforePrompt ?? false
		});

		if (throughPartNumber > (thread.reasoningStrippedThroughPartNumber ?? -1)) {
			await ctx.db.patch('threadRecords', thread._id, {
				reasoningStrippedThroughPartNumber: throughPartNumber
			});
		}

		return true;
	}
});

/** Moves the run to another provider after the active one failed. */
export const fallBackToProvider = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		completionProvider: vCompletionProvider
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);

		if (
			run.cancellationRequestedAt !== undefined ||
			!ownsActiveRunClaim(run, args.claimId, Date.now())
		) {
			return false;
		}

		const thread = await getOwnedThreadRecord(ctx.db, run.userId, run.threadId);

		// The next provider cannot replay the failed provider's reasoning.
		const throughPartNumber = await throughPartNumberForHandoff(ctx, {
			threadId: run.threadId,
			runId: run._id,
			beforePrompt: false
		});

		await ctx.db.patch('runs', run._id, { completionProvider: args.completionProvider });
		await ctx.db.patch('threadRecords', thread._id, {
			completionProvider: args.completionProvider,
			reasoningStrippedThroughPartNumber: Math.max(
				throughPartNumber,
				thread.reasoningStrippedThroughPartNumber ?? -1
			)
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
		usage: v.optional(
			v.object({
				contextTokens: v.number(),
				/** Sent by released agents; ignored. */
				processedTokens: v.optional(v.number()),
				call: v.optional(vModelCallUsage)
			})
		),
		executionSecret: v.string()
	},
	returns: v.union(schema.doc('threadTranscriptParts'), v.null()),
	handler: async (ctx, args) => {
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

			// Agents persist a turn before its tools start, so its jobs may not exist yet.
			if (
				job &&
				(job.callId !== invocation.callId ||
					job.sectionKey !== invocation.sectionKey ||
					job.sectionOrdinal !==
						(invocation.sectionKey === undefined
							? job.sectionOrdinal
							: sectionOrdinals.get(invocation.sectionKey)) ||
					job.attemptSeq !== args.attemptSeq ||
					job.streamId !== args.streamId)
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
			runId: run._id,
			streamId: args.streamId,
			items: args.items,
			work: args.work,
			toolInvocations: args.toolInvocations,
			sections: args.sections
		});

		await recordSettledToolTranscripts(ctx, {
			threadId: run.threadId,
			runId: run._id,
			items: args.items,
			toolInvocations: args.toolInvocations
		});

		if (part && args.usage) {
			const thread = await getOwnedThreadRecord(ctx.db, run.userId, run.threadId);
			await setThreadContextTokens(ctx, thread, args.usage.contextTokens);

			if (args.usage.call) {
				await recordModelCallUsage(ctx, thread, {
					runId: run._id,
					eventId: `turn:${args.claimId}:${args.attemptSeq}`,
					call: args.usage.call
				});
			}
		}

		return part;
	}
});

export const requestCancellation = mutation({
	args: { runId: v.id('runs') },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const run = await getOwnedRun(ctx.db, userId, args.runId);
		const thread = await getOwnedThreadRecord(ctx.db, userId, run.threadId);

		if (thread.parentThreadId !== undefined) {
			const latest = await latestRunForThread(ctx.db, thread._id);

			if (latest?._id === run._id || latest?.continuationOfRunId === run._id) {
				return (await requestThreadTreeCancellation(ctx, thread)).cancelled;
			}
		}

		return await requestRunCancellation(ctx, run);
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
	returns: vExecutorFinalizationResult,
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);

		if (!matchesFinalizeExpectations(run, args)) {
			return await executorFinalizationResult(ctx, run, false);
		}

		if (
			args.status === 'cancelled' &&
			!isRunFinalStatus(run.status) &&
			run.cancellationRequestedAt === undefined
		) {
			const thread = await ctx.db.get('threadRecords', run.threadId);

			if (thread?.parentThreadId !== undefined) {
				await requestThreadTreeCancellation(ctx, thread);
			}
		}

		const accepted = await finalizeRunRecord(ctx, run, args);

		return executorFinalizationResult(ctx, run, accepted);
	}
});

export const finalizeFailedStart = mutation({
	args: {
		submissionId: v.string(),
		threadId: v.optional(v.id('threadRecords')),
		/** Sent by released agents; ignored. */
		prompt: v.optional(v.string()),
		/** Sent by released agents; ignored. */
		storageIds: v.optional(v.array(v.id('_storage'))),
		selectedModel: v.string(),
		completionProvider: v.optional(vCompletionProvider),
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
		claimId: v.string(),
		runId: v.id('runs'),
		text: v.string(),
		lastError: v.string(),
		executionSecret: v.string()
	},
	returns: vExecutorFinalizationResult,
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		// Released agents still report claim lease loss through this mutation.
		const abandoned = args.lastError === LEGACY_RUN_ABANDONED_BY_AGENT;

		const accepted =
			canFinalizeAfterClaimFailure(run, args.claimId) &&
			(await finalizeRunRecord(ctx, run, {
				status: 'failed',
				lastError: abandoned ? RUN_ABANDONED_BY_MACHINE : args.lastError,
				failureKind: abandoned ? 'abandoned' : undefined
			}));

		return executorFinalizationResult(ctx, run, accepted);
	}
});

export const beginToolJob = mutation({
	args: {
		claimId: v.string(),
		runId: v.id('runs'),
		kind: vCurrentExecutorJobKind,
		callId: v.optional(v.string()),
		toolInvocationId: v.string(),
		sectionKey: v.string(),
		sectionOrdinal: v.number(),
		attemptSeq: v.number(),
		streamId: v.string(),
		payload: vCurrentExecutorJobPayload,
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

			if (paymentToolJobKinds.has(args.kind)) {
				const thread = await ctx.db.get('threadRecords', run.threadId);

				if (thread?.parentThreadId !== undefined) {
					throw new Error('Payment tools are not available to subagents.');
				}
			}

			if (
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
