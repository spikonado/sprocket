import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import { ConvexError, type Infer } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { executionSecretHash } from '@convex/lib/auth';
import { RUN_ABANDONED_BY_AGENT } from '@convex/lib/agentErrors';
import {
	areImageUploadIdsEqual,
	getOwnedImageUploads,
	markImageUploadsAttached
} from '@convex/lib/imageUploads';
import {
	attachRunToMachine,
	getOwnedMachine,
	isMachineActive,
	MAX_ACTIVE_MACHINE_RUNS
} from '@convex/lib/machineRuns';
import { isClaimedRunStatus, isRunClaimLeaseActive } from '@convex/lib/runLease';
import { finalizeRunRecord } from '@convex/lib/runFinalize';
import { assertContinuableParent } from '@convex/lib/runResume';
import { assertThreadCanStartRun } from '@convex/lib/runs';
import { startRunLifecycle } from '@convex/runLifecycle';
import { getPromptPart, promptSourceKey } from '@convex/lib/transcriptParts';
import { recordPromptTranscript } from '@convex/lib/transcriptWrites';
import { isRunFinalStatus, type vReasoningEffort, type vServiceTier } from '@convex/lib/validators';

export type QueuedRunRequest = {
	userId: string;
	submissionId: string;
	threadId?: Id<'threadRecords'>;
	repositoryKey?: string;
	prompt: string;
	imageUploadIds: Id<'imageUploads'>[];
	selectedModel: string;
	reasoningEffort: Infer<typeof vReasoningEffort>;
	serviceTier: Infer<typeof vServiceTier>;
	executionSecret: string;
	protocolVersion: number;
	agentVersion?: string;
	machineId?: string;
	continuationOfRunId?: Id<'runs'>;
};

type CreatedGatewayRun = {
	created: boolean;
	runId: Id<'runs'>;
	threadId: Id<'threadRecords'>;
	userId: string;
	promptMessageId?: string;
	promptPart?: Doc<'threadTranscriptParts'>;
};

type GatewayRunTelemetry = {
	completionTransport: 'gateway';
	gatewayProtocolVersion: number;
	agentVersion?: string;
};

export async function createQueuedRunRecord(
	ctx: MutationCtx,
	args: QueuedRunRequest
): Promise<CreatedGatewayRun> {
	if ((args.threadId === undefined) === (args.repositoryKey === undefined)) {
		throw new Error('Exactly one of thread ID or repository key is required.');
	}
	if (args.continuationOfRunId && !args.threadId) {
		throw new Error('A continuation requires an existing thread.');
	}
	const secretHash = await executionSecretHash(args.executionSecret);
	const continuationOfRunId = args.continuationOfRunId;
	const prompt = args.prompt.trim();
	if (!continuationOfRunId && !prompt && args.imageUploadIds.length === 0) {
		throw new Error('Message cannot be empty.');
	}
	const imageUploads = continuationOfRunId
		? []
		: await getOwnedImageUploads(ctx, args.userId, args.imageUploadIds);
	const machineId = args.machineId;
	let machine = null;
	if (machineId) {
		machine = await getOwnedMachine(ctx, args.userId, machineId);
		if (!machine || !isMachineActive(machine)) {
			throw new Error('Machine is not active.');
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
	const fallbackTitle = (prompt || imageUploads[0]?.name || 'New thread').slice(0, 72);
	let threadRecord: Doc<'threadRecords'>;
	if (args.threadId) {
		threadRecord = await getOwnedThreadRecord(ctx.db, args.userId, args.threadId);
	} else {
		const repositoryKey = args.repositoryKey?.trim();
		if (!repositoryKey) throw new Error('Repository key is required for a new thread.');
		const now = Date.now();
		const threadId = await ctx.db.insert('threadRecords', {
			userId: args.userId,
			submissionId: args.submissionId,
			status: 'queued',
			repositoryKey,
			title: fallbackTitle,
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			serviceTier: args.serviceTier,
			lastMessageAt: now
		});
		await ctx.db.insert('threadUsage', {
			threadId,
			userId: args.userId,
			totalTokensProcessed: 0
		});
		threadRecord = (await ctx.db.get('threadRecords', threadId))!;
	}
	let latestRun = await ctx.db
		.query('runs')
		.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadRecord._id))
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
		if (machine) {
			machine = (await ctx.db.get('machines', machine._id)) ?? machine;
		}
	} else {
		assertThreadCanStartRun(latestRun?.status);
	}
	if (continuationOfRunId) {
		assertContinuableParent(latestRun, continuationOfRunId);
	}
	if (machine && machine.runIds.length >= MAX_ACTIVE_MACHINE_RUNS) {
		throw new Error('Machine has too many active runs.');
	}

	const gatewayFields: GatewayRunTelemetry = {
		completionTransport: 'gateway',
		gatewayProtocolVersion: args.protocolVersion
	};
	if (args.agentVersion) {
		gatewayFields.agentVersion = args.agentVersion;
	}
	const runRecord: Omit<Doc<'runs'>, '_id' | '_creationTime'> = {
		threadId: threadRecord._id,
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
	};
	if (machineId) runRecord.machineId = machineId;
	if (continuationOfRunId) runRecord.continuationOfRunId = continuationOfRunId;
	const runId = await ctx.db.insert('runs', runRecord);
	if (machine) {
		await attachRunToMachine(ctx, machine, runId);
	}
	const completionStreamStateId = await ctx.db.insert('completionStreamStates', {
		runId,
		userId: args.userId,
		sequence: 0
	});
	const created: CreatedGatewayRun = {
		created: true,
		runId,
		threadId: threadRecord._id,
		userId: args.userId
	};
	if (!continuationOfRunId) {
		await markImageUploadsAttached(ctx, imageUploads, threadRecord._id);
		created.promptMessageId = promptSourceKey(runId);
		created.promptPart = await recordPromptTranscript(ctx, {
			threadId: threadRecord._id,
			userId: args.userId,
			runId,
			text: prompt,
			imageUploadIds: args.imageUploadIds
		});
	}
	await ctx.db.patch('runs', runId, { completionStreamStateId });
	const threadUpdates = {
		status: 'queued' as const,
		title: threadRecord.title ?? fallbackTitle,
		selectedModel: args.selectedModel,
		reasoningEffort: args.reasoningEffort,
		serviceTier: args.serviceTier,
		lastMessageAt: continuationOfRunId ? threadRecord.lastMessageAt : Date.now()
	};
	await ctx.db.patch('threadRecords', threadRecord._id, threadUpdates);
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
	const existingThread = await ctx.db.get('threadRecords', existingRun.threadId);
	if (
		(args.threadId !== undefined && existingRun.threadId !== args.threadId) ||
		!existingThread ||
		existingThread.userId !== args.userId ||
		(args.repositoryKey !== undefined &&
			existingThread.repositoryKey !== args.repositoryKey.trim()) ||
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
		return {
			created: false,
			runId: existingRun._id,
			threadId: existingRun.threadId,
			userId: args.userId
		};
	}

	const existingPrompt = await getPromptPart(ctx, existingRun.threadId, existingRun._id);
	if (
		!existingPrompt?.prompt ||
		existingPrompt.prompt.text !== prompt ||
		!areImageUploadIdsEqual(
			existingPrompt.prompt.imageUploads.map((upload) => upload.imageUploadId),
			args.imageUploadIds
		)
	) {
		throw new Error('Submission prompt does not match the existing run.');
	}
	const promptPart = await recordPromptTranscript(ctx, {
		threadId: existingRun.threadId,
		userId: args.userId,
		runId: existingRun._id,
		text: prompt,
		imageUploadIds: args.imageUploadIds
	});
	return {
		created: false,
		runId: existingRun._id,
		threadId: existingRun.threadId,
		promptMessageId: promptSourceKey(existingRun._id),
		userId: args.userId,
		promptPart
	};
}

export async function finalizeFailedQueuedStart(
	ctx: MutationCtx,
	args: {
		submissionId: string;
		threadId?: Id<'threadRecords'>;
		prompt: string;
		imageUploadIds: Id<'imageUploads'>[];
		selectedModel: string;
		reasoningEffort: Infer<typeof vReasoningEffort>;
		serviceTier: Infer<typeof vServiceTier>;
		text: string;
		lastError: string;
		executionSecret: string;
	}
): Promise<'finalized' | 'pending' | 'standDown'> {
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
		(args.threadId !== undefined && run.threadId !== args.threadId) ||
		run.selectedModel !== args.selectedModel ||
		run.reasoningEffort !== args.reasoningEffort ||
		run.serviceTier !== args.serviceTier
	) {
		return 'standDown';
	}
	if (!isContinuation) {
		const promptPart = await getPromptPart(ctx, run.threadId, run._id);
		if (
			!promptPart?.prompt ||
			promptPart.prompt.text !== args.prompt.trim() ||
			!areImageUploadIdsEqual(
				promptPart.prompt.imageUploads.map((upload) => upload.imageUploadId),
				args.imageUploadIds
			)
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
