import type { Doc, Id } from '@convex/_generated/dataModel';
import { internal } from '@convex/_generated/api';
import type { MutationCtx } from '@convex/_generated/server';
import { ConvexError, type Infer } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { executionSecretHash } from '@convex/lib/auth';
import { agentError } from '@convex/lib/agentErrors';
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
	automaticAgentContinuationEnabled,
	isAutomaticallyRecoverableRun,
	LEGACY_AUTOMATIC_RECOVERY_SUBMISSION_PREFIX
} from '@convex/lib/runRecovery';
import { assertThreadCanStartRun } from '@convex/lib/runs';
import { getUiPreferences } from '@convex/lib/uiPreferences';
import { headActionablePendingQuestion } from '@convex/lib/agentQuestions';
import { registerChildThread, threadRoot } from '@convex/lib/threadHierarchy';
import { insertQueuedRun } from '@convex/lib/threadRunStatus';
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
	type ServiceTier,
	type vReasoningEffort
} from '@convex/lib/validators';
import { withRunExecution, getRunExecutionState } from '@convex/lib/runExecution';
import { modelServiceTier } from '@convex/lib/models';

export type QueuedRunRequest = {
	userId: string;
	submissionId: string;
	threadId?: Id<'threadRecords'>;
	repositoryKey?: string;
	parentThreadId?: Id<'threadRecords'>;
	prompt: string;
	imageUploadIds: Id<'imageUploads'>[];
	selectedModel: string;
	completionProvider: CompletionProvider;
	reasoningEffort: Infer<typeof vReasoningEffort>;
	fastMode?: boolean;
	serviceTier?: ServiceTier;
	executionSecret: string;
	agentVersion?: string;
	machineId?: string;
	continuationOfRunId?: Id<'runs'>;
	automaticRecovery?: boolean;
	taskDeadlineAt?: number;
	deferPrompt?: boolean;
};

export type ClientRunRequest = Omit<QueuedRunRequest, 'parentThreadId' | 'taskDeadlineAt'>;

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
	const serviceTier = modelServiceTier(args);

	const fastMode = serviceTier === 'fast';

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
	const continuationOfRunId = args.continuationOfRunId;
	const prompt = args.prompt.trim();

	const imageUploads = await getOwnedImageUploads(ctx, args.userId, args.imageUploadIds);
	const recordsPrompt = !continuationOfRunId || Boolean(prompt) || imageUploads.length > 0;
	const machineId = args.machineId;
	let machine = null;

	if (machineId) {
		machine = await getOwnedMachine(ctx, args.userId, machineId);

		if (!machine || !isMachineActive(machine)) {
			throw agentError('MACHINE_NOT_ACTIVE');
		}
	}

	const existingRun = await runForSubmission(ctx, args.userId, args.submissionId);

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
			completionProvider: args.completionProvider,
			reasoningEffort: args.reasoningEffort,
			fastMode,
			serviceTier,
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
				provider: args.completionProvider
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

	if (continuationOfRunId) {
		const parent = assertContinuableParent(latestRun, continuationOfRunId, recordsPrompt);

		const automaticRecovery =
			args.automaticRecovery === true ||
			args.submissionId.startsWith(LEGACY_AUTOMATIC_RECOVERY_SUBMISSION_PREFIX);

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
		throw agentError('SUBMISSION_WAITING');
	}

	const promptBody = recordsPrompt
		? { text: prompt, imageUploads: await attachmentMetaForUploads(ctx, args.imageUploadIds) }
		: undefined;

	const runRecord: Parameters<typeof insertQueuedRun>[1] = {
		threadId: threadRecord._id,
		userId: args.userId,
		submissionId: args.submissionId,
		executionSecretHash: secretHash,
		selectedModel: args.selectedModel,
		completionProvider: args.completionProvider,
		reasoningEffort: args.reasoningEffort,
		fastMode,
		serviceTier
	};

	if (args.agentVersion) runRecord.agentVersion = args.agentVersion;

	if (machineId) runRecord.machineId = machineId;

	if (continuationOfRunId) runRecord.continuationOfRunId = continuationOfRunId;

	if (taskDeadlineAt !== undefined) runRecord.taskDeadlineAt = taskDeadlineAt;

	if (promptBody && args.deferPrompt) runRecord.pendingPrompt = promptBody;

	const runId = await insertQueuedRun(ctx, runRecord);

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
		title: threadRecord.title ?? fallbackTitle,
		selectedModel: args.selectedModel,
		completionProvider: args.completionProvider,
		reasoningEffort: args.reasoningEffort,
		fastMode,
		serviceTier,
		lastMessageAt: Date.now()
	};

	await ctx.db.patch('threadRecords', threadRecord._id, threadUpdates);

	if (created.promptPart) {
		await generateTitleAfterFirstPrompt(
			ctx,
			{ ...threadRecord, title: threadUpdates.title },
			created.promptPart
		);
	}

	await startRunLifecycle(ctx, runId);

	return created;
}

export async function generateTitleAfterFirstPrompt(
	ctx: MutationCtx,
	thread: Doc<'threadRecords'>,
	promptPart: Doc<'threadTranscriptParts'>
): Promise<void> {
	if (
		thread.titleRenameKey !== undefined ||
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
		throw agentError('SUBMISSION_OWNED_BY_ANOTHER_EXECUTOR');
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
		modelServiceTier(existingRun) !== modelServiceTier(args) ||
		!continuationMatches
	) {
		throw agentError('SUBMISSION_OWNED_BY_ANOTHER_RUN');
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

function runForSubmission(ctx: MutationCtx, userId: string, submissionId: string) {
	return ctx.db
		.query('runs')
		.withIndex('by_userId_submissionId', (query) =>
			query.eq('userId', userId).eq('submissionId', submissionId)
		)
		.unique();
}

async function runForExecutionSecret(ctx: MutationCtx, executionSecret: string) {
	const secretHash = await executionSecretHash(executionSecret);

	return await ctx.db
		.query('runs')
		.withIndex('by_executionSecretHash', (query) => query.eq('executionSecretHash', secretHash))
		.unique();
}

async function submittedByCaller(ctx: MutationCtx, submissionId: string): Promise<boolean> {
	const identity = await ctx.auth.getUserIdentity();

	return (
		identity !== null && (await runForSubmission(ctx, identity.subject, submissionId)) !== null
	);
}

export async function finalizeFailedQueuedStart(
	ctx: MutationCtx,
	args: {
		submissionId: string;
		threadId?: Id<'threadRecords'>;
		selectedModel: string;
		completionProvider: CompletionProvider;
		reasoningEffort: Infer<typeof vReasoningEffort>;
		fastMode?: boolean;
		serviceTier?: ServiceTier;
		lastError: string;
		executionSecret: string;
	}
): Promise<'finalized' | 'pending' | 'standDown'> {
	const run = await runForExecutionSecret(ctx, args.executionSecret);

	if (!run) return (await submittedByCaller(ctx, args.submissionId)) ? 'standDown' : 'pending';

	if (
		run.status !== 'queued' ||
		(args.threadId !== undefined && run.threadId !== args.threadId) ||
		run.selectedModel !== args.selectedModel ||
		(run.completionProvider ?? 'spikonado') !== args.completionProvider ||
		run.reasoningEffort !== args.reasoningEffort ||
		modelServiceTier(run) !== modelServiceTier(args)
	) {
		return 'standDown';
	}

	await finalizeRunRecord(ctx, await withRunExecution(ctx.db, run), {
		status: 'failed',
		lastError: args.lastError
	});

	return 'finalized';
}
