import type { Doc, Id } from '@convex/_generated/dataModel';
import { internal } from '@convex/_generated/api';
import {
	internalMutation,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx
} from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import {
	finalizeQuestionOptions,
	headActionablePendingQuestion,
	isPendingQuestionActionable,
	formatQuestionContinuationPrompt,
	MAX_QUESTION_TIMEOUT_MS,
	normalizeQuestionAnswer,
	QUESTION_TIMEOUT_CHECKPOINT_MS,
	validateQuestionTimeoutMs,
	validateQuestionText
} from '@convex/lib/agentQuestions';
import { getExecutionRun, getExecutionRunRecord, getUserId } from '@convex/lib/auth';
import { assertRunAcceptsModelCompletion, toAgentToolConvexError } from '@convex/lib/agentErrors';
import { vAgentQuestionSnapshot } from '@convex/lib/docs';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
import { isRunFinalStatus, vAskQuestionOption } from '@convex/lib/validators';
import {
	captureThreadActivityBeforeChange,
	updateThreadHierarchyAfterChange
} from '@convex/lib/threadHierarchy';

const DEFAULT_QUESTION_TIMEOUT_MS = 30 * 60 * 1000;

const MIN_QUESTION_TIMEOUT_MS = 1_000;

export type AgentQuestionSnapshot = Infer<typeof vAgentQuestionSnapshot>;

export function toAgentQuestionSnapshot(question: Doc<'agentQuestions'>): AgentQuestionSnapshot {
	const snapshot: AgentQuestionSnapshot = {
		threadId: question.threadId,
		questionId: question._id,
		question: question.question,
		options: question.options,
		status: question.status,
		sequence: question.sequence,
		createdAt: question.createdAt
	};

	if (question.timeoutAt !== undefined) snapshot.timeoutAt = question.timeoutAt;

	if (question.answer) snapshot.answer = question.answer;

	if (question.answeredAt !== undefined) snapshot.answeredAt = question.answeredAt;

	return snapshot;
}

async function nextThreadSequence(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<number> {
	const latest = await ctx.db
		.query('agentQuestions')
		.withIndex('by_threadId_sequence', (query) => query.eq('threadId', threadId))
		.order('desc')
		.first();

	return (latest?.sequence ?? 0) + 1;
}

type CreateQuestionArgs = {
	runId: Id<'runs'>;
	claimId: string;
	question: string;
	options: Infer<typeof vAskQuestionOption>[];
	timeoutMs?: number | null;
	executionSecret: string;
};

type CreatedQuestion = {
	questionId: Id<'agentQuestions'>;
	question: string;
	options: Infer<typeof vAskQuestionOption>[];
	timeoutAt?: number;
	sequence: number;
};

async function createQuestion(
	ctx: MutationCtx,
	args: CreateQuestionArgs,
	resolveTimeoutMs: (timeoutMs: number | null | undefined) => number | undefined
): Promise<CreatedQuestion> {
	const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
	assertRunAcceptsModelCompletion(run);

	if (run.claimId !== args.claimId || !isRunClaimLeaseActive(run, Date.now())) {
		throw new Error('Run is no longer active.');
	}

	if (!run.activeJobId) {
		throw new Error('Ask question requires an active tool job.');
	}

	const question = validateQuestionText(args.question);
	const options = finalizeQuestionOptions(args.options);

	const timeoutMs = resolveTimeoutMs(args.timeoutMs);
	const createdAt = Date.now();
	const timeoutAt = timeoutMs === undefined ? undefined : createdAt + timeoutMs;
	const sequence = await nextThreadSequence(ctx, run.threadId);

	const before = await captureThreadActivityBeforeChange(ctx, run.threadId);

	const questionId = await ctx.db.insert('agentQuestions', {
		threadId: run.threadId,
		runId: run._id,
		jobId: run.activeJobId,
		question,
		options,
		status: timeoutMs === 0 ? 'timedOut' : 'pending',
		createdAt,
		timeoutAt,
		answeredAt: timeoutMs === 0 ? createdAt : undefined,
		sequence
	});

	if (timeoutAt !== undefined && timeoutMs !== 0) {
		await scheduleDeadlineCheck(ctx, questionId, createdAt, timeoutAt);
	}

	await updateThreadHierarchyAfterChange(ctx, before);

	return {
		questionId,
		question,
		options,
		timeoutAt,
		sequence
	};
}

async function scheduleDeadlineCheck(
	ctx: MutationCtx,
	questionId: Id<'agentQuestions'>,
	now: number,
	timeoutAt: number
): Promise<void> {
	const remaining = timeoutAt - now;
	// Convex caps scheduled timestamps about five years out; checkpoint distant
	// deadlines at a bounded interval so the durable deadline never changes.
	const delay = Math.min(Math.max(remaining, 0), QUESTION_TIMEOUT_CHECKPOINT_MS);

	await ctx.scheduler.runAfter(delay, internal.agentQuestions.timeout, { questionId });
}

const vCreatedQuestion = v.object({
	questionId: v.id('agentQuestions'),
	question: v.string(),
	options: v.array(vAskQuestionOption),
	timeoutAt: v.optional(v.number()),
	sequence: v.number()
});

const vCreateQuestionArgs = {
	runId: v.id('runs'),
	claimId: v.string(),
	question: v.string(),
	options: v.array(vAskQuestionOption),
	executionSecret: v.string()
};

// Legacy create kept for released clients: omitted timeout defaults to 30m and
// numeric values are clamped to [1s, 24h].
export const create = mutation({
	args: {
		...vCreateQuestionArgs,
		timeoutMs: v.optional(v.number())
	},
	returns: vCreatedQuestion,
	handler: async (ctx, args) => {
		try {
			return await createQuestion(ctx, args, (timeoutMs) =>
				Math.min(
					MAX_QUESTION_TIMEOUT_MS,
					Math.max(MIN_QUESTION_TIMEOUT_MS, Math.floor(timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS))
				)
			);
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const createWithOptionalExpiry = mutation({
	args: {
		...vCreateQuestionArgs,
		timeoutMs: v.optional(v.union(v.number(), v.null()))
	},
	returns: vCreatedQuestion,
	handler: async (ctx, args) => {
		try {
			return await createQuestion(ctx, args, validateQuestionTimeoutMs);
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const answer = mutation({
	args: {
		threadId: v.id('threadRecords'),
		questionId: v.id('agentQuestions'),
		optionId: v.optional(v.string()),
		text: v.optional(v.string())
	},
	returns: v.object({
		question: vAgentQuestionSnapshot,
		continuation: v.optional(
			v.object({
				runId: v.id('runs'),
				prompt: v.string()
			})
		)
	}),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		const result = await answerPendingQuestion(ctx, args);

		return {
			question: toAgentQuestionSnapshot(result.question),
			continuation: result.kind === 'answered' ? result.continuation : undefined
		};
	}
});

type QuestionAnswerResult = {
	question: Doc<'agentQuestions'>;
} & (
	| { kind: 'answered'; continuation?: Awaited<ReturnType<typeof questionContinuation>> }
	| { kind: 'alreadyAnswered' }
);

export async function answerPendingQuestion(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		questionId: Id<'agentQuestions'>;
		optionId?: string;
		text?: string;
	}
): Promise<QuestionAnswerResult> {
	const question = await ctx.db.get('agentQuestions', args.questionId);

	if (!question || question.threadId !== args.threadId) {
		throw new Error('Question not found.');
	}

	if (question.status === 'answered') {
		if (!question.answer) {
			throw new Error('Question is no longer awaiting an answer.');
		}

		return {
			kind: 'alreadyAnswered',
			question
		};
	}

	if (!(await isPendingQuestionActionable(ctx.db, question))) {
		throw new Error('Question is no longer awaiting an answer.');
	}

	const head = await headActionablePendingQuestion(ctx.db, args.threadId);

	if (!head || head._id !== question._id) {
		throw new Error('Answer the earliest pending question first.');
	}

	const answer = normalizeQuestionAnswer({
		options: question.options,
		optionId: args.optionId,
		text: args.text
	});

	const answeredAt = Date.now();
	const run = await ctx.db.get('runs', question.runId);

	const questionPatch = {
		status: 'answered',
		answer,
		answeredAt,
		requiresContinuation:
			question.requiresContinuation || (run !== null && isRunFinalStatus(run.status))
	} as const;

	const before = await captureThreadActivityBeforeChange(ctx, args.threadId);

	await ctx.db.patch('agentQuestions', question._id, questionPatch);
	await updateThreadHierarchyAfterChange(ctx, before);

	return {
		kind: 'answered',
		question: { ...question, ...questionPatch },
		continuation: await questionContinuation(ctx, question, run)
	};
}

export async function questionContinuation(
	ctx: QueryCtx | MutationCtx,
	question: Pick<Doc<'agentQuestions'>, 'threadId' | 'runId'>,
	knownRun?: Doc<'runs'> | null
) {
	const [nextQuestion, run, latestRun] = await Promise.all([
		headActionablePendingQuestion(ctx.db, question.threadId),
		knownRun !== undefined ? Promise.resolve(knownRun) : ctx.db.get('runs', question.runId),
		ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', question.threadId))
			.order('desc')
			.first()
	]);

	const continuationOfRunId =
		nextQuestion === null &&
		run !== null &&
		latestRun?._id === run._id &&
		isRunFinalStatus(run.status) &&
		run.status !== 'cancelled' &&
		run.cancellationRequestedAt === undefined
			? run._id
			: undefined;

	if (!continuationOfRunId) return undefined;

	const runQuestions = await ctx.db
		.query('agentQuestions')
		.withIndex('by_runId_sequence', (query) => query.eq('runId', continuationOfRunId))
		.order('asc')
		.collect();

	const prompt = formatQuestionContinuationPrompt(
		runQuestions.flatMap((entry) =>
			entry.requiresContinuation && entry.answer
				? [{ question: entry.question, answer: entry.answer }]
				: []
		)
	);

	return { runId: continuationOfRunId, prompt };
}

export const timeout = internalMutation({
	args: {
		questionId: v.id('agentQuestions')
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const question = await ctx.db.get('agentQuestions', args.questionId);

		if (!question || question.status !== 'pending') {
			return null;
		}

		const run = await ctx.db.get('runs', question.runId);
		const now = Date.now();

		if (run?.status === 'cancelled') {
			await ctx.db.patch('agentQuestions', question._id, {
				status: 'cancelled',
				answeredAt: run.completedAt ?? now
			});

			return null;
		}

		if (question.timeoutAt === undefined) {
			return null;
		}

		if (question.timeoutAt > now) {
			await scheduleDeadlineCheck(ctx, question._id, now, question.timeoutAt);

			return null;
		}

		const before = await captureThreadActivityBeforeChange(ctx, question.threadId);

		await ctx.db.patch('agentQuestions', question._id, {
			status: 'timedOut',
			answeredAt: now
		});
		await updateThreadHierarchyAfterChange(ctx, before);

		return null;
	}
});

export const getForExecutor = query({
	args: {
		runId: v.id('runs'),
		questionId: v.id('agentQuestions'),
		executionSecret: v.string()
	},
	returns: v.union(vAgentQuestionSnapshot, v.null()),
	handler: async (ctx, args) => {
		try {
			const run = await getExecutionRunRecord(ctx, args.runId, args.executionSecret);
			const question = await ctx.db.get('agentQuestions', args.questionId);

			if (!question || question.runId !== run._id) {
				return null;
			}

			return toAgentQuestionSnapshot(question);
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const headPendingForThread = query({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.union(vAgentQuestionSnapshot, v.null()),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);
		const head = await headActionablePendingQuestion(ctx.db, args.threadId);

		return head ? toAgentQuestionSnapshot(head) : null;
	}
});

/** Cancel a thread's pending questions. Called synchronously from the manual
 * cancellation path so stopped threads reject answers immediately, before the
 * run reaches its eventual cancelled terminal state. */
export async function cancelPendingQuestionsForThread(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<boolean> {
	const before = await captureThreadActivityBeforeChange(ctx, threadId);
	const now = Date.now();
	let cancelledAny = false;

	const latest = await ctx.db
		.query('runs')
		.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
		.order('desc')
		.first();

	if (latest) {
		for await (const question of ctx.db
			.query('agentQuestions')
			.withIndex('by_runId_sequence', (query) => query.eq('runId', latest._id))) {
			if (question.continuationClaim) {
				await ctx.db.patch('agentQuestions', question._id, { continuationClaim: undefined });
				cancelledAny = true;
			}
		}
	}

	for await (const question of ctx.db
		.query('agentQuestions')
		.withIndex('by_threadId_status_sequence', (query) =>
			query.eq('threadId', threadId).eq('status', 'pending')
		)) {
		await ctx.db.patch('agentQuestions', question._id, {
			status: 'cancelled',
			answeredAt: now
		});
		cancelledAny = true;
	}

	await updateThreadHierarchyAfterChange(ctx, before);

	return cancelledAny;
}
