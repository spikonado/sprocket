import type { Doc, Id } from '@convex/_generated/dataModel';
import { internal } from '@convex/_generated/api';
import type { MutationCtx } from '@convex/_generated/server';
import { ConvexError, type Infer } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { executionSecretHash } from '@convex/lib/auth';
import { RUN_ABANDONED_BY_AGENT, SPROCKET_SUBMISSION_WAITING } from '@convex/lib/agentErrors';
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
import {
	AUTOMATIC_RECOVERY_SUBMISSION_PREFIX,
	isAutomaticallyRecoverableRun
} from '@convex/lib/runRecovery';
import { assertThreadCanStartRun } from '@convex/lib/runs';
import { headActionablePendingQuestion } from '@convex/lib/agentQuestions';
import {
	captureThreadActivityBeforeChange,
	updateThreadHierarchyAfterChange,
	registerChildThread,
	threadRoot,
	unsettleRootOfThread
} from '@convex/lib/threadHierarchy';
import { startRunLifecycle } from '@convex/runLifecycle';
import { getPromptPart } from '@convex/lib/transcriptParts';
import { recordPromptTranscript } from '@convex/lib/transcriptWrites';
import {
	isRunFinalStatus,
	type CompletionProvider,
	type vReasoningEffort
} from '@convex/lib/validators';
import { withRunExecution, getRunExecutionState } from '@convex/lib/runExecution';
import { reconcileTerminalRun } from '@convex/lib/runTerminal';

export type QueuedRunRequest = {
	userId: string;
	submissionId: string;
	threadId?: Id<'threadRecords'>;
	repositoryKey?: string;
	// Native delegation only; never accepted from ordinary client submissions.
	parentThreadId?: Id<'threadRecords'>;
	prompt: string;
	isDelegatedPrompt?: boolean;
	imageUploadIds: Id<'imageUploads'>[];
	selectedModel: string;
	completionProvider?: CompletionProvider;
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

export async function submissionReadiness(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<boolean> {
	let latestRun = await ctx.db
		.query('runs')
		.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
		.order('desc')
		.first();

	if (!latestRun) return true;

	const run = await withRunExecution(ctx.db, latestRun);

	if (isClaimedRunStatus(run.status) && !isRunClaimLeaseActive(run, Date.now())) {
		await finalizeRunRecord(ctx, run, {
			text: `Run aborted: ${RUN_ABANDONED_BY_AGENT}`,
			status: 'failed',
			lastError: RUN_ABANDONED_BY_AGENT
		});
		latestRun = (await ctx.db.get('runs', run._id))!;
	} else {
		assertThreadCanStartRun(latestRun.status);
	}

	return await terminalJobsReady(ctx, latestRun);
}

async function terminalJobsReady(ctx: MutationCtx, run: Doc<'runs'>): Promise<boolean> {
	let execution = await getRunExecutionState(ctx.db, run._id);

	if (execution?.terminalJobsReconciled === undefined) {
		await reconcileTerminalRun(ctx, run, {
			completedAt: run.completedAt ?? Date.now(),
			jobCursor: -1,
			questionCursor: -1
		});
		execution = await getRunExecutionState(ctx.db, run._id);
	}

	return execution?.terminalJobsReconciled === true;
}

export async function createQueuedRunRecord(
	ctx: MutationCtx,
	args: QueuedRunRequest
): Promise<CreatedGatewayRun> {
	if ((args.threadId === undefined) === (args.repositoryKey === undefined)) {
		throw new Error('Exactly one of thread ID or repository key is required.');
	}

	if (args.parentThreadId !== undefined && args.threadId !== undefined) {
		throw new Error('A parent linkage requires a new thread.');
	}

	if (args.continuationOfRunId && !args.threadId) {
		throw new Error('A continuation requires an existing thread.');
	}

	const secretHash = await executionSecretHash(args.executionSecret);
	const completionProvider = args.completionProvider ?? 'spikonado';
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

		let parentThread: Doc<'threadRecords'> | null = null;

		if (args.parentThreadId !== undefined) {
			parentThread = await ctx.db.get('threadRecords', args.parentThreadId);

			if (
				!parentThread ||
				parentThread.userId !== args.userId ||
				parentThread.repositoryKey !== repositoryKey
			) {
				throw new Error('Parent thread not found.');
			}
		}

		const now = Date.now();

		const threadId = await ctx.db.insert('threadRecords', {
			userId: args.userId,
			submissionId: args.submissionId,
			parentThreadId: args.parentThreadId,
			status: 'queued',
			repositoryKey,
			title: fallbackTitle,
			selectedModel: args.selectedModel,
			completionProvider,
			reasoningEffort: args.reasoningEffort,
			fastMode: args.fastMode,
			lastMessageAt: now
		});

		await ctx.db.insert('threadUsage', { threadId, userId: args.userId });
		threadRecord = (await ctx.db.get('threadRecords', threadId))!;

		if (parentThread) {
			await registerChildThread(ctx, threadRecord);
		}
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
		const parent = assertContinuableParent(latestRun, continuationOfRunId, recordsPrompt);

		if (
			args.submissionId.startsWith(AUTOMATIC_RECOVERY_SUBMISSION_PREFIX) &&
			(!machineId ||
				!isAutomaticallyRecoverableRun(parent, machineId) ||
				recordsPrompt ||
				(await threadRoot(ctx.db, threadRecord)).archivedAt !== undefined)
		) {
			throw new ConvexError('This run cannot recover automatically.');
		}
	}

	if (await headActionablePendingQuestion(ctx.db, threadRecord._id)) {
		throw new Error('Answer or cancel pending questions before sending another message.');
	}

	if (machine && machine.runIds.length >= MAX_ACTIVE_MACHINE_RUNS) {
		throw new Error('Machine has too many active runs.');
	}

	if (latestRun && !(await terminalJobsReady(ctx, latestRun))) {
		throw new ConvexError(SPROCKET_SUBMISSION_WAITING);
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
		completionProvider,
		reasoningEffort: args.reasoningEffort,
		fastMode: args.fastMode,
		startedAt: Date.now(),
		...gatewayFields
	};

	if (machineId) runRecord.machineId = machineId;

	if (continuationOfRunId) runRecord.continuationOfRunId = continuationOfRunId;

	const before = await captureThreadActivityBeforeChange(ctx, threadRecord._id);

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

	await markImageUploadsAttached(ctx, imageUploads, threadRecord._id);

	if (recordsPrompt) {
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
		completionProvider,
		reasoningEffort: args.reasoningEffort,
		fastMode: args.fastMode,
		lastMessageAt: recordsPrompt ? Date.now() : threadRecord.lastMessageAt,
		archivedAt: undefined
	};

	await ctx.db.patch('threadRecords', threadRecord._id, threadUpdates);

	if (created.promptPart && !args.isDelegatedPrompt) {
		const preferences = await ctx.db
			.query('uiPreferences')
			.withIndex('by_userId', (query) => query.eq('userId', args.userId))
			.unique();

		if (preferences?.automaticThreadTitles !== false) {
			await ctx.scheduler.runAfter(0, internal.threadTitles.generate, {
				runId,
				expectedTitle: threadUpdates.title
			});
		}
	}

	await unsettleRootOfThread(ctx, threadRecord);
	await updateThreadHierarchyAfterChange(ctx, before);
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
		(args.parentThreadId !== undefined && existingThread.parentThreadId !== args.parentThreadId) ||
		(args.machineId !== undefined && existingRun.machineId !== args.machineId) ||
		(args.repositoryKey !== undefined &&
			existingThread.repositoryKey !== args.repositoryKey.trim()) ||
		existingRun.selectedModel !== args.selectedModel ||
		(existingRun.completionProvider ?? 'spikonado') !== (args.completionProvider ?? 'spikonado') ||
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

	if (recordsPrompt && existingPrompt) reconciled.promptPart = existingPrompt;

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
		completionProvider?: CompletionProvider;
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
		(run.completionProvider ?? 'spikonado') !== (args.completionProvider ?? 'spikonado') ||
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
			promptPart?.prompt?.text !== prompt ||
			!areStorageIdsEqual(
				promptPart?.prompt?.imageUploads.map((upload) => upload.storageId),
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
