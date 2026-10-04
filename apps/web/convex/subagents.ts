import { internal } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import {
	internalMutation,
	mutation,
	type MutationCtx,
	type QueryCtx
} from '@convex/_generated/server';
import { paginationOptsValidator } from 'convex/server';
import { v, type Infer } from 'convex/values';
import {
	answerPendingQuestion,
	cancelPendingQuestionsForThread,
	questionContinuation,
	pendingQuestionsForThread,
	toAgentQuestionSnapshot
} from '@convex/agentQuestions';
import { assertRunAcceptsModelCompletion, toAgentToolConvexError } from '@convex/lib/agentErrors';
import { normalizeTaskTimeoutMs } from '@convex/lib/models';
import {
	selectedThreadLifecyclePhase,
	vSelectedThreadLifecyclePhase
} from '@convex/lib/runCancellation';
import { executionSecretHash, getExecutionRun } from '@convex/lib/auth';
import {
	vAgentQuestionSnapshot,
	vTranscriptPartsResult,
	vTranscriptStateResult
} from '@convex/lib/docs';
import { createQueuedRunRecord, submissionReadiness } from '@convex/lib/runCreate';
import { requestRunCancellation } from '@convex/runLifecycle';
import { finalizeRunRecord } from '@convex/lib/runFinalize';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import { getRunWithExecution } from '@convex/lib/runExecution';
import { transcriptHistoryFromNumber } from '@convex/lib/contextHandoff';
import {
	assertDescendantThreadAccess,
	listDirectChildrenPage,
	refreshThreadHierarchyActivity
} from '@convex/lib/threadHierarchy';
import {
	getTranscriptState,
	getPromptPart,
	loadTranscriptPartsByNumbers,
	transcriptPartsForClient
} from '@convex/lib/transcriptParts';
import {
	isRunFinalStatus,
	vCompletionProvider,
	vReasoningEffort,
	vRunStatus,
	vAskQuestionAnswer
} from '@convex/lib/validators';

const vSubagentSettings = v.object({
	model: v.string(),
	reasoning: vReasoningEffort,
	fast: v.boolean(),
	completionProvider: vCompletionProvider
});

const vCallerRun = v.object({
	runId: v.id('runs'),
	claimId: v.string(),
	executionSecret: v.string()
});

const vDescendantCaller = vCallerRun.extend({ threadId: v.id('threadRecords') });

function subagentSettings(
	source: Doc<'threadRecords'> | Doc<'runs'>
): Infer<typeof vSubagentSettings> {
	return {
		model: source.selectedModel,
		reasoning: source.reasoningEffort,
		fast: source.fastMode,
		completionProvider: source.completionProvider ?? 'spikonado'
	};
}

export const recoverSubmission = mutation({
	args: {
		...vCallerRun.fields,
		submissionId: v.string(),
		childExecutionSecret: v.string()
	},
	returns: v.union(
		v.null(),
		v.object({
			threadId: v.id('threadRecords'),
			runId: v.id('runs'),
			created: v.boolean(),
			status: vRunStatus,
			lastError: v.optional(v.string()),
			continuationOfRunId: v.optional(v.id('runs')),
			settings: vSubagentSettings,
			prompt: v.string()
		})
	),
	handler: async (ctx, args) => {
		try {
			const caller = await requireLiveCallerRun(ctx, args);

			const run = await submissionRun(ctx, caller, args.submissionId);

			if (!run) return null;

			await assertDescendantThreadAccess(ctx.db, caller, run.threadId);

			if (run.executionSecretHash !== (await executionSecretHash(args.childExecutionSecret))) {
				throw new Error('Submission belongs to a different executor.');
			}

			const prompt = (await getPromptPart(ctx, run.threadId, run._id))?.prompt?.text ?? '';

			return {
				threadId: run.threadId,
				runId: run._id,
				created: false,
				status: run.status,
				lastError: run.lastError,
				continuationOfRunId: run.continuationOfRunId,
				settings: subagentSettings(run),
				prompt
			};
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

async function latestRunForThread(ctx: QueryCtx | MutationCtx, threadId: Id<'threadRecords'>) {
	return await ctx.db
		.query('runs')
		.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
		.order('desc')
		.first();
}

async function submissionRun(
	ctx: QueryCtx | MutationCtx,
	caller: Doc<'runs'>,
	submissionId: string
) {
	return await ctx.db
		.query('runs')
		.withIndex('by_userId_submissionId', (q) =>
			q.eq('userId', caller.userId).eq('submissionId', submissionId)
		)
		.unique();
}

async function activeRunForThread(ctx: QueryCtx | MutationCtx, threadId: Id<'threadRecords'>) {
	const latest = await latestRunForThread(ctx, threadId);

	return latest && !isRunFinalStatus(latest.status) ? latest : null;
}

async function requireLiveCallerRun(ctx: MutationCtx, args: Infer<typeof vCallerRun>) {
	const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
	assertRunAcceptsModelCompletion(run);

	if (!ownsActiveRunClaim(run, args.claimId, Date.now())) {
		throw new Error('Run is no longer active.');
	}

	return run;
}

async function requireDescendantThread(ctx: MutationCtx, args: Infer<typeof vDescendantCaller>) {
	const callerRun = await requireLiveCallerRun(ctx, args);

	return await assertDescendantThreadAccess(ctx.db, callerRun, args.threadId);
}

export const prepareSubmission = mutation({
	args: vDescendantCaller.fields,
	returns: v.boolean(),
	handler: async (ctx, args) => {
		try {
			const thread = await requireDescendantThread(ctx, args);

			return await submissionReadiness(ctx, thread._id);
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const createOrSend = mutation({
	args: {
		...vCallerRun.fields,
		submissionId: v.string(),
		childExecutionSecret: v.string(),
		continuationOfRunId: v.optional(v.id('runs')),
		continuationQuestionId: v.optional(v.id('agentQuestions')),
		threadId: v.optional(v.id('threadRecords')),
		prompt: v.string(),
		model: v.optional(v.string()),
		reasoning: v.optional(vReasoningEffort),
		fast: v.optional(v.boolean()),
		timeoutMs: v.optional(v.number())
	},
	returns: v.object({
		threadId: v.id('threadRecords'),
		runId: v.id('runs'),
		created: v.boolean(),
		status: vRunStatus,
		lastError: v.optional(v.string()),
		timeoutMs: v.optional(v.number()),
		continuationOfRunId: v.optional(v.id('runs')),
		settings: vSubagentSettings
	}),
	handler: async (ctx, args) => {
		try {
			const callerRun = await requireLiveCallerRun(ctx, args);
			const callerThread = await ctx.db.get('threadRecords', callerRun.threadId);

			if (!callerThread) throw new Error('Thread not found.');

			if (!args.prompt.trim()) throw new Error('A subagent requires a nonempty prompt.');

			const creating = args.threadId === undefined;

			const targetThread =
				args.threadId === undefined
					? callerThread
					: await assertDescendantThreadAccess(ctx.db, callerRun, args.threadId);

			if (args.model === undefined || args.reasoning === undefined || args.fast === undefined) {
				throw new Error('Model, reasoning, and fast overrides must be resolved before submission.');
			}

			// Creation inherits the caller's effective provider; follow-ups keep
			// the target child's saved provider.
			const completionProvider = creating
				? (callerRun.completionProvider ?? 'spikonado')
				: (targetThread.completionProvider ?? 'spikonado');

			const timeoutMs = normalizeTaskTimeoutMs(args.timeoutMs);

			if (!callerRun.machineId) throw new Error('Caller has no execution machine.');

			if (args.childExecutionSecret === args.executionSecret || !args.childExecutionSecret.trim()) {
				throw new Error('Child requires a fresh execution secret.');
			}

			const continuationOfRunId = args.continuationOfRunId;

			if (creating && continuationOfRunId) throw new Error('A new child cannot continue a run.');

			if (args.continuationQuestionId) {
				const accepted = await submissionRun(ctx, callerRun, args.submissionId);

				if (!accepted) {
					const question = await ctx.db.get('agentQuestions', args.continuationQuestionId);
					const claim = question?.continuationClaim;
					const job = claim ? await ctx.db.get('executorJobs', claim.toolJobId) : null;
					const continuation = question ? await questionContinuation(ctx, question) : undefined;

					if (
						question?.threadId !== targetThread._id ||
						question?.status !== 'answered' ||
						claim?.claimId !== args.claimId ||
						job?.runId !== callerRun._id ||
						!continuation ||
						continuation.runId !== continuationOfRunId ||
						continuation.prompt !== args.prompt
					) {
						throw new Error('Question continuation is no longer available.');
					}
				}
			}

			const created = await createQueuedRunRecord(ctx, {
				userId: callerRun.userId,
				submissionId: args.submissionId,
				threadId: creating ? undefined : targetThread._id,
				repositoryKey: creating ? callerThread.repositoryKey : undefined,
				parentThreadId: creating ? callerRun.threadId : undefined,
				prompt: args.prompt,
				imageUploadIds: [],
				selectedModel: args.model,
				completionProvider,
				reasoningEffort: args.reasoning,
				fastMode: args.fast,
				machineId: callerRun.machineId,
				continuationOfRunId,
				executionSecret: args.childExecutionSecret,
				protocolVersion: callerRun.gatewayProtocolVersion ?? 0
			});

			if (created.created && timeoutMs !== undefined) {
				const deadlineAt = Date.now() + timeoutMs;
				await ctx.scheduler.runAt(deadlineAt, internal.subagents.enforceTaskDeadline, {
					runId: created.runId,
					deadlineAt
				});
			}

			const thread = await ctx.db.get('threadRecords', created.threadId);

			if (!thread) throw new Error('Thread not found.');

			const run = await ctx.db.get('runs', created.runId);

			return {
				threadId: created.threadId,
				runId: created.runId,
				created: created.created,
				status: run?.status ?? thread.status,
				lastError: run?.lastError,
				timeoutMs,
				continuationOfRunId: run?.continuationOfRunId,
				settings: subagentSettings(run ?? thread)
			};
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const enforceTaskDeadline = internalMutation({
	args: { runId: v.id('runs'), deadlineAt: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await getRunWithExecution(ctx.db, args.runId);

		if (!run || isRunFinalStatus(run.status)) return null;

		if (args.deadlineAt > Date.now()) {
			await ctx.scheduler.runAt(args.deadlineAt, internal.subagents.enforceTaskDeadline, args);

			return null;
		}

		await finalizeRunRecord(ctx, run, {
			text: 'Task deadline exceeded.',
			status: 'cancelled',
			lastError: 'Task deadline exceeded.'
		});

		return null;
	}
});

export const snapshot = mutation({
	args: vDescendantCaller.fields,
	returns: v.object({
		threadId: v.id('threadRecords'),
		parentThreadId: v.optional(v.id('threadRecords')),
		status: vSelectedThreadLifecyclePhase,
		lastError: v.optional(v.string()),
		activeRunId: v.optional(v.id('runs')),
		startedAt: v.optional(v.number()),
		pendingQuestions: v.array(vAgentQuestionSnapshot),
		settings: vSubagentSettings
	}),
	handler: async (ctx, args) => {
		try {
			const thread = await requireDescendantThread(ctx, args);
			const pending = await pendingQuestionsForThread(ctx, args.threadId);
			const latest = await latestRunForThread(ctx, thread._id);
			const active = latest && !isRunFinalStatus(latest.status) ? latest : null;

			return {
				threadId: thread._id,
				parentThreadId: thread.parentThreadId,
				status: selectedThreadLifecyclePhase({ run: latest, waitingForInput: pending.length > 0 }),
				lastError: latest?.lastError,
				activeRunId: active?._id,
				startedAt: active?.startedAt,
				pendingQuestions: pending.map(toAgentQuestionSnapshot),
				settings: subagentSettings(thread)
			};
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const listChildren = mutation({
	args: {
		...vCallerRun.fields,
		parentThreadId: v.optional(v.id('threadRecords')),
		paginationOpts: paginationOptsValidator
	},
	returns: v.object({
		page: v.array(
			v.object({
				threadId: v.id('threadRecords'),
				parentThreadId: v.optional(v.id('threadRecords')),
				title: v.optional(v.string()),
				status: vSelectedThreadLifecyclePhase,
				lastError: v.optional(v.string()),
				lastMessageAt: v.number(),
				settings: vSubagentSettings
			})
		),
		isDone: v.boolean(),
		continueCursor: v.string()
	}),
	handler: async (ctx, args) => {
		try {
			const callerRun = await requireLiveCallerRun(ctx, args);
			const parentId = args.parentThreadId ?? callerRun.threadId;

			if (parentId !== callerRun.threadId) {
				await assertDescendantThreadAccess(ctx.db, callerRun, parentId);
			}

			const result = await listDirectChildrenPage(
				ctx,
				callerRun.userId,
				parentId,
				args.paginationOpts
			);

			const page = await Promise.all(
				result.page.map(async (child) => {
					const latest = await latestRunForThread(ctx, child._id);
					const pending = await pendingQuestionsForThread(ctx, child._id);

					return {
						threadId: child._id,
						parentThreadId: child.parentThreadId,
						title: child.title,
						status: selectedThreadLifecyclePhase({
							run: latest,
							waitingForInput: pending.length > 0
						}),
						lastError: latest?.lastError,
						lastMessageAt: child.lastMessageAt,
						settings: subagentSettings(child)
					};
				})
			);

			return { page, isDone: result.isDone, continueCursor: result.continueCursor };
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const control = mutation({
	args: {
		...vDescendantCaller.fields,
		action: v.union(v.literal('stop'), v.literal('answer_question')),
		toolJobId: v.optional(v.id('executorJobs')),
		questionId: v.optional(v.id('agentQuestions')),
		optionId: v.optional(v.string()),
		text: v.optional(v.string())
	},
	returns: v.object({
		status: vRunStatus,
		lastError: v.optional(v.string()),
		answer: v.optional(vAskQuestionAnswer),
		alreadyAnswered: v.optional(v.boolean()),
		continuation: v.optional(v.object({ runId: v.id('runs'), prompt: v.string() }))
	}),
	handler: async (ctx, args) => {
		try {
			const callerRun = await requireLiveCallerRun(ctx, args);
			const thread = await assertDescendantThreadAccess(ctx.db, callerRun, args.threadId);

			if (args.action === 'stop') {
				const active = await activeRunForThread(ctx, thread._id);

				if (active) {
					await requestRunCancellation(ctx, active);
				} else {
					// No live run: still retire pending questions awaiting
					// continuation so Stop is meaningful on idle-but-waiting threads.
					await cancelPendingQuestionsForThread(ctx, thread._id);
				}

				await refreshThreadHierarchyActivity(ctx, thread._id);
				const latest = await latestRunForThread(ctx, thread._id);

				return {
					status: latest?.status ?? thread.status,
					lastError: latest?.lastError
				};
			}

			if (!args.questionId) {
				throw new Error('answer_question requires a questionId.');
			}

			if (args.toolJobId) {
				const job = await ctx.db.get('executorJobs', args.toolJobId);
				const payload = job?.payload;

				if (
					!job ||
					job.runId !== callerRun._id ||
					job.kind !== 'control_subagent' ||
					!payload ||
					!('action' in payload) ||
					payload.action !== 'answer_question' ||
					!('threadId' in payload) ||
					payload.threadId !== args.threadId ||
					!('questionId' in payload) ||
					payload.questionId !== args.questionId
				) {
					throw new Error('Invalid subagent control job.');
				}
			}

			const result = await answerPendingQuestion(ctx, {
				threadId: thread._id,
				questionId: args.questionId,
				optionId: args.optionId,
				text: args.text
			});

			const latest = await latestRunForThread(ctx, thread._id);

			if (result.kind === 'alreadyAnswered') {
				const question = await ctx.db.get('agentQuestions', args.questionId);

				const retryContinuation =
					args.toolJobId &&
					question?.continuationClaim?.toolJobId === args.toolJobId &&
					question.continuationClaim.claimId === args.claimId
						? await questionContinuation(ctx, question, { latestRun: latest })
						: undefined;

				return {
					status: latest?.status ?? thread.status,
					lastError: latest?.lastError,
					answer: result.answer,
					alreadyAnswered: true,
					continuation: retryContinuation
				};
			}

			if (args.toolJobId && result.continuation) {
				await ctx.db.patch('agentQuestions', args.questionId, {
					continuationClaim: { toolJobId: args.toolJobId, claimId: args.claimId }
				});
			}

			return {
				status: latest?.status ?? thread.status,
				lastError: latest?.lastError,
				answer: result.question.answer,
				continuation: result.continuation
			};
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const transcriptState = mutation({
	args: vDescendantCaller.fields,
	returns: vTranscriptStateResult,
	handler: async (ctx, args) => {
		try {
			const thread = await requireDescendantThread(ctx, args);
			const state = await getTranscriptState(ctx, thread._id);
			const historyFromNumber = transcriptHistoryFromNumber(thread);

			const result: Infer<typeof vTranscriptStateResult> = {
				threadId: thread._id,
				totalParts: state?.totalParts ?? 0,
				historyFromNumber
			};

			if (thread.contextSummary) result.contextSummary = thread.contextSummary;

			return result;
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const transcriptParts = mutation({
	args: {
		...vDescendantCaller.fields,
		numbers: v.array(v.number())
	},
	returns: vTranscriptPartsResult,
	handler: async (ctx, args) => {
		try {
			const thread = await requireDescendantThread(ctx, args);

			const parts = await transcriptPartsForClient(
				ctx,
				await loadTranscriptPartsByNumbers(ctx, thread._id, args.numbers)
			);

			return { threadId: thread._id, parts };
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const threadMonitorInfo = mutation({
	args: vDescendantCaller.fields,
	returns: v.object({
		threadId: v.id('threadRecords'),
		userId: v.string(),
		status: vSelectedThreadLifecyclePhase,
		transcript: v.object({ totalParts: v.number(), historyFromNumber: v.number() }),
		lastError: v.optional(v.string()),
		active: v.boolean(),
		pendingQuestions: v.array(vAgentQuestionSnapshot)
	}),
	handler: async (ctx, args) => {
		try {
			const thread = await requireDescendantThread(ctx, args);
			const pending = await pendingQuestionsForThread(ctx, thread._id);
			const state = await getTranscriptState(ctx, thread._id);
			const latest = await latestRunForThread(ctx, thread._id);

			return {
				threadId: thread._id,
				userId: thread.userId,
				transcript: { totalParts: state?.totalParts ?? 0, historyFromNumber: 0 },
				status: selectedThreadLifecyclePhase({ run: latest, waitingForInput: pending.length > 0 }),
				lastError: latest?.lastError,
				active: (latest !== null && !isRunFinalStatus(latest.status)) || pending.length > 0,
				pendingQuestions: pending.map(toAgentQuestionSnapshot)
			};
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});
