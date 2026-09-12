import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import { ConvexError, type Infer } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { executionSecretHash } from '@convex/lib/auth';
import { RUN_ABANDONED_BY_AGENT } from '@convex/lib/agentErrors';
import {
	getOwnedImageUploads,
	markImageUploadsAttached,
	areStorageIdsEqual,
	storageIdsForImageUploadIds
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
import { getPromptPart } from '@convex/lib/transcriptParts';
import { recordPromptTranscript } from '@convex/lib/transcriptWrites';
import { isRunFinalStatus, type vReasoningEffort } from '@convex/lib/validators';
import { withRunExecution } from '@convex/lib/runExecution';

export type QueuedRunRequest = {
	userId: string;
	submissionId: string;
	threadId?: Id<'threadRecords'>;
	repositoryKey?: string;
	prompt: string;
	imageUploadIds: Id<'imageUploads'>[];
	selectedModel: string;
	reasoningEffort: Infer<typeof vReasoningEffort>;
	fastMode: boolean;
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
	promptPart?: Doc<'threadTranscriptParts'>;
};

type GatewayRunTelemetry = {
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
	const imageUploads = await getOwnedImageUploads(ctx, args.userId, args.imageUploadIds);
	const recordsPrompt = !continuationOfRunId || Boolean(prompt) || imageUploads.length > 0;
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
			fastMode: args.fastMode,
			lastMessageAt: now
		});
		await ctx.db.insert('threadUsage', { threadId, userId: args.userId });
		threadRecord = (await ctx.db.get('threadRecords', threadId))!;
	}
	const latestRunRecord = await ctx.db
		.query('runs')
		.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadRecord._id))
		.order('desc')
		.first();
	let latestRun = latestRunRecord ? await withRunExecution(ctx.db, latestRunRecord) : null;
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
		const finalizedRun = await ctx.db.get('runs', latestRun._id);
		if (finalizedRun) latestRun = await withRunExecution(ctx.db, finalizedRun);
		if (machine) {
			machine = (await ctx.db.get('machines', machine._id)) ?? machine;
		}
	} else {
		assertThreadCanStartRun(latestRun?.status);
	}
	if (continuationOfRunId) {
		assertContinuableParent(latestRun, continuationOfRunId, recordsPrompt);
	}
	if (machine && machine.runIds.length >= MAX_ACTIVE_MACHINE_RUNS) {
		throw new Error('Machine has too many active runs.');
	}

	const gatewayFields: GatewayRunTelemetry = {
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
		selectedModel: args.selectedModel,
		reasoningEffort: args.reasoningEffort,
		fastMode: args.fastMode,
		startedAt: Date.now(),
		...gatewayFields
	};
	if (machineId) runRecord.machineId = machineId;
	if (continuationOfRunId) runRecord.continuationOfRunId = continuationOfRunId;
	const runId = await ctx.db.insert('runs', runRecord);
	await ctx.db.insert('runExecutionStates', { runId, completionAttemptSeq: 0 });
	if (machine) {
		await attachRunToMachine(ctx, machine, runId);
	}
	const created: CreatedGatewayRun = {
		created: true,
		runId,
		threadId: threadRecord._id,
		userId: args.userId
	};
	if (recordsPrompt) {
		await markImageUploadsAttached(ctx, imageUploads, threadRecord._id);
		created.promptPart = await recordPromptTranscript(ctx, {
			threadId: threadRecord._id,
			userId: args.userId,
			runId,
			text: prompt,
			imageUploadIds: args.imageUploadIds
		});
	}
	const threadUpdates = {
		status: 'queued' as const,
		title: threadRecord.title ?? fallbackTitle,
		selectedModel: args.selectedModel,
		reasoningEffort: args.reasoningEffort,
		fastMode: args.fastMode,
		lastMessageAt: recordsPrompt ? Date.now() : threadRecord.lastMessageAt
	};
	await ctx.db.patch('threadRecords', threadRecord._id, threadUpdates);
	await startRunLifecycle(ctx, runId);
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
		existingRun.fastMode !== args.fastMode ||
		!continuationMatches
	) {
		throw new ConvexError('Submission belongs to a different or incomplete run.');
	}

	if (!isRunFinalStatus(existingRun.status)) {
		await startRunLifecycle(ctx, existingRun._id);
	}

	const existingPrompt = await getPromptPart(ctx, existingRun.threadId, existingRun._id);
	const requestedStorageIds = await storageIdsForImageUploadIds(ctx, args.imageUploadIds);
	const recordsPrompt =
		!args.continuationOfRunId || Boolean(prompt) || args.imageUploadIds.length > 0;
	if (recordsPrompt) {
		if (
			!existingPrompt?.prompt ||
			existingPrompt.prompt.text !== prompt ||
			requestedStorageIds === null ||
			!areStorageIdsEqual(
				existingPrompt.prompt.imageUploads.map((upload) => upload.storageId),
				requestedStorageIds
			)
		) {
			throw new Error('Submission prompt does not match the existing run.');
		}
	} else if (existingPrompt !== null || requestedStorageIds === null) {
		throw new Error('Submission prompt does not match the existing run.');
	}
	const reconciled: CreatedGatewayRun = {
		created: false,
		runId: existingRun._id,
		threadId: existingRun.threadId,
		userId: args.userId
	};
	if (recordsPrompt) {
		reconciled.promptPart = await recordPromptTranscript(ctx, {
			threadId: existingRun.threadId,
			userId: args.userId,
			runId: existingRun._id,
			text: prompt,
			imageUploadIds: args.imageUploadIds
		});
	}
	return reconciled;
}

export async function finalizeFailedQueuedStart(
	ctx: MutationCtx,
	args: {
		submissionId: string;
		threadId?: Id<'threadRecords'>;
		prompt: string;
		storageIds: Id<'_storage'>[];
		selectedModel: string;
		reasoningEffort: Infer<typeof vReasoningEffort>;
		fastMode: boolean;
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
		run.fastMode !== args.fastMode
	) {
		return 'standDown';
	}
	const prompt = args.prompt.trim();
	const promptPart = await getPromptPart(ctx, run.threadId, run._id);
	const recordsPrompt = !isContinuation || Boolean(prompt) || args.storageIds.length > 0;
	if (recordsPrompt) {
		if (
			!promptPart?.prompt ||
			promptPart.prompt.text !== prompt ||
			!areStorageIdsEqual(
				promptPart.prompt.imageUploads.map((upload) => upload.storageId),
				args.storageIds
			)
		) {
			return 'standDown';
		}
	} else if (promptPart !== null) {
		return 'standDown';
	}
	await finalizeRunRecord(ctx, await withRunExecution(ctx.db, run), {
		text: args.text,
		status: 'failed',
		lastError: args.lastError
	});
	return 'finalized';
}
