import type { Doc, Id } from '@convex/_generated/dataModel';
import { internal } from '@convex/_generated/api';
import type { MutationCtx } from '@convex/_generated/server';
import { ConvexError, type Infer } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { executionSecretHash } from '@convex/lib/auth';
import { SPROCKET_SUBMISSION_WAITING } from '@convex/lib/agentErrors';
import { getOwnedImageUploads, markImageUploadsAttached } from '@convex/lib/imageUploads';
import {
	attachRunToMachine,
	getOwnedMachine,
	isMachineActive,
	MAX_ACTIVE_MACHINE_RUNS
} from '@convex/lib/machineRuns';
import { isClaimedRunStatus, isRunClaimLeaseActive } from '@convex/lib/runLease';
import { abandonRunRecord, finalizeRunRecord } from '@convex/lib/runFinalize';
import { assertContinuableParent } from '@convex/lib/runResume';
import {
	AUTOMATIC_RECOVERY_SUBMISSION_PREFIX,
	automaticAgentContinuationEnabled,
	isAutomaticallyRecoverableRun
} from '@convex/lib/runRecovery';
import { assertThreadCanStartRun } from '@convex/lib/runs';
import { getUiPreferences } from '@convex/lib/uiPreferences';
import { headActionablePendingQuestion } from '@convex/lib/agentQuestions';
import {
	captureThreadActivityBeforeChange,
	updateThreadHierarchyAfterChange,
	registerChildThread,
	threadRoot,
	unsettleRootOfThread
} from '@convex/lib/threadHierarchy';
import { startRunLifecycle } from '@convex/runLifecycle';
import {
	attachmentMetaForUploads,
	firstUserPromptPart,
	getPromptPart
} from '@convex/lib/transcriptParts';
import { recordPromptTranscript } from '@convex/lib/transcriptWrites';
import { analyticsId, captureAnonymous } from '@convex/lib/analytics';
import {
	isRunFinalStatus,
	type CompletionProvider,
	type vReasoningEffort
} from '@convex/lib/validators';
import { withRunExecution, getRunExecutionState } from '@convex/lib/runExecution';

export type QueuedRunRequest = {
	userId: string;
	submissionId: string;
	threadId?: Id<'threadRecords'>;
	repositoryKey?: string;
	// Native delegation only; never accepted from ordinary client submissions.
	parentThreadId?: Id<'threadRecords'>;
	prompt: string;
	imageUploadIds: Id<'imageUploads'>[];
	selectedModel: string;
	completionProvider?: CompletionProvider;
	reasoningEffort: Infer<typeof vReasoningEffort>;
	fastMode: boolean;
	executionSecret: string;
	agentVersion?: string;
	machineId?: string;
	continuationOfRunId?: Id<'runs'>;
	taskDeadlineAt?: number;
	/** The run writes its prompt part when it begins. Released clients omit it. */
	deferPrompt?: boolean;
};

type CreatedGatewayRun = {
	created: boolean;
	runId: Id<'runs'>;
	threadId: Id<'threadRecords'>;
	userId: string;
	promptPart?: Doc<'threadTranscriptParts'>;
};

export async function submissionReadiness(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<boolean> {
	let latestRun = await ctx.db
		.query('runs')
		.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
		.order('desc')
		.first();

	if (!latestRun) return true;

	const run = await withRunExecution(ctx.db, latestRun);

	if (isClaimedRunStatus(run.status) && !isRunClaimLeaseActive(run, Date.now())) {
		await abandonRunRecord(ctx, run);
		latestRun = (await ctx.db.get('runs', run._id))!;
	} else {
		assertThreadCanStartRun(latestRun.status);
	}

	return await terminalJobsReady(ctx, latestRun);
}

async function terminalJobsReady(ctx: MutationCtx, run: Doc<'runs'>): Promise<boolean> {
	const execution = await getRunExecutionState(ctx.db, run._id);

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
		return await reconcileExistingQueuedRun(ctx, args, existingRun, secretHash);
	}

	if (!continuationOfRunId && !prompt && args.imageUploadIds.length === 0) {
		throw new Error('Message cannot be empty.');
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
			parentThreadId: args.parentThreadId,
			status: 'queued',
			repositoryKey,
			title: fallbackTitle,
			selectedModel: args.selectedModel,
			completionProvider,
			reasoningEffort: args.reasoningEffort,
			fastMode: args.fastMode,
			cwd: parentThread?.cwd,
			lastMessageAt: now
		});

		threadRecord = (await ctx.db.get('threadRecords', threadId))!;

		const sessionId = await analyticsId(threadId);

		await captureAnonymous(ctx, {
			distinctId: sessionId,
			event: 'thread_created',
			properties: {
				$ai_session_id: sessionId,
				parent_session_id: args.parentThreadId ? await analyticsId(args.parentThreadId) : null,
				model: args.selectedModel,
				provider: completionProvider
			}
		});

		if (parentThread) {
			await registerChildThread(ctx, threadRecord);
		}
	}

	const latestRunRecord = await ctx.db
		.query('runs')
		.withIndex('by_threadId', (query) => query.eq('threadId', threadRecord._id))
		.order('desc')
		.first();

	let latestRun = latestRunRecord ? await withRunExecution(ctx.db, latestRunRecord) : null;

	if (
		latestRun &&
		isClaimedRunStatus(latestRun.status) &&
		!isRunClaimLeaseActive(latestRun, Date.now())
	) {
		await abandonRunRecord(ctx, latestRun);
		const finalizedRun = await ctx.db.get('runs', latestRun._id);

		if (finalizedRun) latestRun = await withRunExecution(ctx.db, finalizedRun);

		if (machine) {
			machine = (await ctx.db.get('machines', machine._id)) ?? machine;
		}
	} else {
		assertThreadCanStartRun(latestRun?.status);
	}

	let taskDeadlineAt = args.taskDeadlineAt;
	let parentPendingPrompt: Doc<'runs'>['pendingPrompt'];

	if (continuationOfRunId) {
		const parent = assertContinuableParent(latestRun, continuationOfRunId, recordsPrompt);
		parentPendingPrompt = parent.pendingPrompt;
		const automaticRecovery = args.submissionId.startsWith(AUTOMATIC_RECOVERY_SUBMISSION_PREFIX);

		if (
			automaticRecovery &&
			(!machineId ||
				!(await automaticAgentContinuationEnabled(ctx.db, args.userId)) ||
				!isAutomaticallyRecoverableRun(parent, machineId) ||
				recordsPrompt ||
				(await threadRoot(ctx.db, threadRecord)).archivedAt !== undefined)
		) {
			throw new ConvexError('This run cannot recover automatically.');
		}

		if (automaticRecovery) taskDeadlineAt ??= parent.taskDeadlineAt;
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

	// A parent that failed before it began never wrote its prompt.
	const promptBody = recordsPrompt
		? { text: prompt, imageUploads: await attachmentMetaForUploads(ctx, args.imageUploadIds) }
		: parentPendingPrompt;

	const runRecord: Omit<Doc<'runs'>, '_id' | '_creationTime'> = {
		threadId: threadRecord._id,
		userId: args.userId,
		submissionId: args.submissionId,
		status: 'queued' as const,
		executionSecretHash: secretHash,
		selectedModel: args.selectedModel,
		completionProvider,
		reasoningEffort: args.reasoningEffort,
		fastMode: args.fastMode
	};

	if (args.agentVersion) runRecord.agentVersion = args.agentVersion;

	if (machineId) runRecord.machineId = machineId;

	if (continuationOfRunId) runRecord.continuationOfRunId = continuationOfRunId;

	if (taskDeadlineAt !== undefined) runRecord.taskDeadlineAt = taskDeadlineAt;

	if (promptBody && args.deferPrompt) runRecord.pendingPrompt = promptBody;

	const before = await captureThreadActivityBeforeChange(ctx, threadRecord._id);

	const runId = await ctx.db.insert('runs', runRecord);
	await ctx.db.insert('runExecutionStates', { runId, completionAttemptSeq: 0 });

	if (taskDeadlineAt !== undefined) {
		await ctx.scheduler.runAt(taskDeadlineAt, internal.subagents.enforceTaskDeadline, {
			runId,
			deadlineAt: taskDeadlineAt
		});
	}

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

	if (promptBody && !args.deferPrompt) {
		created.promptPart = await recordPromptTranscript(ctx, {
			threadId: threadRecord._id,
			runId,
			prompt: promptBody
		});
	}

	const threadUpdates = {
		status: 'queued' as const,
		title: threadRecord.title ?? fallbackTitle,
		selectedModel: args.selectedModel,
		completionProvider,
		reasoningEffort: args.reasoningEffort,
		fastMode: args.fastMode,
		lastMessageAt: Date.now(),
		archivedAt: undefined
	};

	await ctx.db.patch('threadRecords', threadRecord._id, threadUpdates);

	if (created.promptPart) {
		await generateTitleAfterFirstPrompt(
			ctx,
			{ ...threadRecord, title: threadUpdates.title },
			created.promptPart
		);
	}

	await unsettleRootOfThread(ctx, threadRecord);
	await updateThreadHierarchyAfterChange(ctx, before);
	await startRunLifecycle(ctx, runId);

	return created;
}

export async function generateTitleAfterFirstPrompt(
	ctx: MutationCtx,
	thread: Doc<'threadRecords'>,
	promptPart: Doc<'threadTranscriptParts'>
): Promise<void> {
	if (
		(await firstUserPromptPart(ctx, thread._id))?._id !== promptPart._id ||
		(await getUiPreferences(ctx.db, thread.userId))?.automaticThreadTitles === false
	) {
		return;
	}

	await ctx.scheduler.runAfter(0, internal.threadTitles.generate, {
		runId: promptPart.runId,
		expectedTitle: thread.title ?? '',
		expectedRenameKey: thread.titleRenameKey
	});
}

async function reconcileExistingQueuedRun(
	ctx: MutationCtx,
	args: QueuedRunRequest,
	existingRun: Doc<'runs'>,
	secretHash: string
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

	const reconciled: CreatedGatewayRun = {
		created: false,
		runId: existingRun._id,
		threadId: existingRun.threadId,
		userId: args.userId
	};

	if (existingPrompt) reconciled.promptPart = existingPrompt;

	return reconciled;
}

export async function finalizeFailedQueuedStart(
	ctx: MutationCtx,
	args: {
		submissionId: string;
		threadId?: Id<'threadRecords'>;
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

	await finalizeRunRecord(ctx, await withRunExecution(ctx.db, run), {
		status: 'failed',
		lastError: args.lastError
	});

	return 'finalized';
}
