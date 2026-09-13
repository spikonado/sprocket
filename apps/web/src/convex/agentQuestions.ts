import type { Doc, Id } from '@convex/_generated/dataModel';
import { patchInboxThread, wakeInboxThread } from './lib/inbox';
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
	formatQuestionContinuationPrompt,
	MAX_QUESTION_TIMEOUT_MS,
	normalizeQuestionAnswer,
	validateQuestionText
} from '@convex/lib/agentQuestions';
import { getExecutionRun, getExecutionRunRecord, getUserId } from '@convex/lib/auth';
import { assertRunAcceptsModelCompletion, toAgentToolConvexError } from '@convex/lib/agentErrors';
import { vAgentQuestionSnapshot } from '@convex/lib/docs';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
import { isRunFinalStatus, vAskQuestionOption } from '@convex/lib/validators';

const DEFAULT_QUESTION_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_QUESTION_TIMEOUT_MS = 1_000;

export type AgentQuestionSnapshot = Infer<typeof vAgentQuestionSnapshot>;

function toSnapshot(question: Doc<'agentQuestions'>): AgentQuestionSnapshot {
	const snapshot: AgentQuestionSnapshot = {
		threadId: question.threadId,
		questionId: question._id,
		question: question.question,
		options: question.options,
		status: question.status,
		sequence: question.sequence,
		createdAt: question.createdAt,
		timeoutAt: question.timeoutAt
	};
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

async function headPendingQuestion(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<Doc<'agentQuestions'> | null> {
	return await ctx.db
		.query('agentQuestions')
		.withIndex('by_threadId_status_sequence', (query) =>
			query.eq('threadId', threadId).eq('status', 'pending')
		)
		.order('asc')
		.first();
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
	returns: v.object({
		questionId: v.id('agentQuestions'),
		question: v.string(),
		options: v.array(vAskQuestionOption),
		timeoutAt: v.number(),
		sequence: v.number()
	}),
	handler: async (ctx, args) => {
		try {
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
			const timeoutMs = Math.min(
				MAX_QUESTION_TIMEOUT_MS,
				Math.max(MIN_QUESTION_TIMEOUT_MS, Math.floor(args.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS))
			);
			const createdAt = Date.now();
			const thread = await ctx.db.get('threadRecords', run.threadId);
			if (thread) {
				await patchInboxThread(ctx, thread, { hasPendingQuestion: true });
				await wakeInboxThread(ctx, thread, createdAt);
			}
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

		const question = await ctx.db.get('agentQuestions', args.questionId);
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
		const answeredAt = Date.now();
		await ctx.db.patch('agentQuestions', question._id, {
			status: 'answered',
			answer,
			answeredAt
		});

		const snapshot = toSnapshot({
			...question,
			status: 'answered',
			answer,
			answeredAt
		});
		const nextQuestion = await headPendingQuestion(ctx, args.threadId);
		const thread = await ctx.db.get('threadRecords', args.threadId);
		if (thread) await patchInboxThread(ctx, thread, { hasPendingQuestion: nextQuestion !== null });
		const run = await ctx.db.get('runs', question.runId);
		const latestRun = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', args.threadId))
			.order('desc')
			.first();
		const continuationOfRunId =
			nextQuestion === null &&
			run !== null &&
			latestRun?._id === run._id &&
			isRunFinalStatus(run.status) &&
			run.status !== 'cancelled'
				? run._id
				: undefined;
		if (!continuationOfRunId) {
			return { question: snapshot };
		}

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
		return {
			question: snapshot,
			continuation: { runId: continuationOfRunId, prompt }
		};
	}
});

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
		await ctx.db.patch('agentQuestions', question._id, {
			status: 'timedOut',
			answeredAt: Date.now()
		});
		const thread = await ctx.db.get('threadRecords', question.threadId);
		if (thread)
			await patchInboxThread(ctx, thread, {
				hasPendingQuestion: (await headPendingQuestion(ctx, question.threadId)) !== null
			});
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
			return toSnapshot(question);
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
		const head = await headPendingQuestion(ctx, args.threadId);
		return head ? toSnapshot(head) : null;
	}
});
