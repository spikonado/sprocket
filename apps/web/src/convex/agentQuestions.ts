import type { Doc, Id } from '@convex/_generated/dataModel';
import { internal } from '@convex/_generated/api';
import {
	internalMutation,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx
} from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import {
	finalizeQuestionOptions,
	normalizeQuestionAnswer,
	validateQuestionText,
	type AgentQuestionOption
} from '@convex/lib/agentQuestions';
import { getExecutionRun, getUserId } from '@convex/lib/auth';
import { assertRunAcceptsModelCompletion } from '@convex/lib/agentErrors';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
import { vAskQuestionOption } from '@convex/lib/validators';

const DEFAULT_QUESTION_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_QUESTION_TIMEOUT_MS = 1_000;
const MAX_QUESTION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

type AgentQuestionSnapshot = {
	threadId: Id<'threadRecords'>;
	questionId: Id<'agentQuestions'>;
	question: string;
	options: AgentQuestionOption[];
	status: Doc<'agentQuestions'>['status'];
	answer?: Doc<'agentQuestions'>['answer'];
	sequence: number;
	createdAt: number;
	timeoutAt: number;
	answeredAt?: number;
};

function toSnapshot(question: Doc<'agentQuestions'>): AgentQuestionSnapshot {
	return {
		threadId: question.threadId,
		questionId: question._id,
		question: question.question,
		options: question.options,
		status: question.status,
		...(question.answer ? { answer: question.answer } : {}),
		sequence: question.sequence,
		createdAt: question.createdAt,
		timeoutAt: question.timeoutAt,
		...(question.answeredAt !== undefined ? { answeredAt: question.answeredAt } : {})
	};
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

async function listPendingQuestions(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<Doc<'agentQuestions'>[]> {
	return await ctx.db
		.query('agentQuestions')
		.withIndex('by_threadId_status_sequence', (query) =>
			query.eq('threadId', threadId).eq('status', 'pending')
		)
		.order('asc')
		.collect();
}

async function headPendingQuestion(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<Doc<'agentQuestions'> | null> {
	const pending = await listPendingQuestions(ctx, threadId);
	return pending[0] ?? null;
}

/** First pending question that has not yet reached timeoutAt (UI head). */
async function headLivePendingQuestion(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'threadRecords'>,
	now: number
): Promise<Doc<'agentQuestions'> | null> {
	const pending = await listPendingQuestions(ctx, threadId);
	return pending.find((question) => question.timeoutAt > now) ?? null;
}

/** Mark past-due pending questions timedOut so FIFO can advance before the scheduler fires. */
async function expireOverduePendingQuestions(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>,
	now: number
): Promise<void> {
	const pending = await listPendingQuestions(ctx, threadId);
	for (const question of pending) {
		if (question.timeoutAt > now) {
			continue;
		}
		await ctx.db.patch(question._id, {
			status: 'timedOut',
			answeredAt: now
		});
	}
}

export const create = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		question: v.string(),
		options: v.array(vAskQuestionOption),
		timeoutMs: v.optional(v.number()),
		executionSecret: v.string()
	},
	handler: async (
		ctx,
		args
	): Promise<{
		questionId: Id<'agentQuestions'>;
		question: string;
		options: AgentQuestionOption[];
		timeoutAt: number;
		sequence: number;
	}> => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		assertRunAcceptsModelCompletion(run.status);
		if (run.claimId !== args.claimId || !isRunClaimLeaseActive(run, Date.now())) {
			throw new Error('Run is no longer active.');
		}
		if (!run.activeJobId) {
			throw new Error('Ask question requires an active tool job.');
		}

		const question = validateQuestionText(args.question);
		const options = finalizeQuestionOptions(args.options);
		const timeoutMs = Math.min(
			MAX_QUESTION_TIMEOUT_MS,
			Math.max(MIN_QUESTION_TIMEOUT_MS, Math.floor(args.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS))
		);
		const createdAt = Date.now();
		const timeoutAt = createdAt + timeoutMs;
		const sequence = await nextThreadSequence(ctx, run.threadId);

		const questionId = await ctx.db.insert('agentQuestions', {
			threadId: run.threadId,
			runId: run._id,
			jobId: run.activeJobId,
			question,
			options,
			status: 'pending',
			createdAt,
			timeoutAt,
			sequence
		});

		await ctx.scheduler.runAfter(timeoutMs, internal.agentQuestions.timeout, { questionId });

		return {
			questionId,
			question,
			options,
			timeoutAt,
			sequence
		};
	}
});

export const answer = mutation({
	args: {
		threadId: v.id('threadRecords'),
		questionId: v.id('agentQuestions'),
		optionId: v.optional(v.string()),
		text: v.optional(v.string())
	},
	handler: async (ctx, args): Promise<AgentQuestionSnapshot> => {
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		const now = Date.now();
		await expireOverduePendingQuestions(ctx, args.threadId, now);

		const question = await ctx.db.get(args.questionId);
		if (!question || question.threadId !== args.threadId) {
			throw new Error('Question not found.');
		}
		if (question.status !== 'pending') {
			throw new Error('Question is no longer awaiting an answer.');
		}

		const head = await headPendingQuestion(ctx, args.threadId);
		if (!head || head._id !== question._id) {
			throw new Error('Answer the earliest pending question first.');
		}

		const answer = normalizeQuestionAnswer({
			options: question.options,
			optionId: args.optionId,
			text: args.text
		});
		await ctx.db.patch(question._id, {
			status: 'answered',
			answer,
			answeredAt: now
		});

		return toSnapshot({
			...question,
			status: 'answered',
			answer,
			answeredAt: now
		});
	}
});

export const timeout = internalMutation({
	args: {
		questionId: v.id('agentQuestions')
	},
	handler: async (ctx, args): Promise<void> => {
		const question = await ctx.db.get(args.questionId);
		if (!question || question.status !== 'pending') {
			return;
		}
		await ctx.db.patch(question._id, {
			status: 'timedOut',
			answeredAt: Date.now()
		});
	}
});

export const getForExecutor = query({
	args: {
		runId: v.id('runs'),
		questionId: v.id('agentQuestions'),
		executionSecret: v.string()
	},
	handler: async (ctx, args): Promise<AgentQuestionSnapshot | null> => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		const question = await ctx.db.get(args.questionId);
		if (!question || question.runId !== run._id) {
			return null;
		}
		return toSnapshot(question);
	}
});

export const headPendingForThread = query({
	args: {
		threadId: v.id('threadRecords')
	},
	handler: async (ctx, args): Promise<AgentQuestionSnapshot | null> => {
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);
		const head = await headLivePendingQuestion(ctx, args.threadId, Date.now());
		return head ? toSnapshot(head) : null;
	}
});
