import type { Doc, Id } from '@convex/_generated/dataModel';
import { internalMutation, internalQuery, mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedRun, getOwnedThreadRecord, getOwnedWorkspaceSession } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { buildCanonicalAgentHistory, findLatestPrompt } from '@convex/lib/agentHistory';
import { appendThreadMessage, getThreadMessage } from '@convex/lib/threadMessages';
import { buildThreadTranscript, type ThreadTranscriptMessage } from '@convex/lib/threadTranscript';
import {
	ensureAssistantToolPartsFromJobs,
	type AssistantPart
} from '@web-lib/assistant-tool-parts';
import {
	type AgentHistoryMessage,
	isRunFinalStatus,
	vExecutorJobKind,
	vExecutorJobPayload,
	vRunFinalStatus,
	vAssistantMessagePart
} from '@convex/lib/validators';

export const start = mutation({
	args: {
		guestId: v.optional(v.string()),
		runId: v.id('runs')
	},
	handler: async (ctx, args): Promise<Doc<'runs'>> => {
		const userId: string = await getUserId(ctx, args.guestId);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		if (isRunFinalStatus(run.status)) {
			return run;
		}

		await ctx.db.patch(args.runId, {
			status: 'running',
			lastError: undefined
		});

		return {
			...run,
			status: 'running',
			lastError: undefined
		};
	}
});

export const getContext = query({
	args: {
		guestId: v.optional(v.string()),
		runId: v.id('runs')
	},
	handler: async (
		ctx,
		args
	): Promise<{
		run: Doc<'runs'>;
		threadRecord: Doc<'threadRecords'>;
		workspaceSession: Doc<'workspaceSessions'>;
		prompt: string;
		agentHistory: AgentHistoryMessage[];
	}> => {
		const userId: string = await getUserId(ctx, args.guestId);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		const threadRecord: Doc<'threadRecords'> = await getOwnedThreadRecord(
			ctx.db,
			userId,
			run.threadId
		);
		const workspaceSession: Doc<'workspaceSessions'> = await getOwnedWorkspaceSession(
			ctx.db,
			userId,
			run.workspaceSessionId
		);
		const messages: ThreadTranscriptMessage[] = await buildThreadTranscript(ctx, run.threadId);
		const jobs: Doc<'executorJobs'>[] = await ctx.db
			.query('executorJobs')
			.withIndex('by_threadId_sequence', (query) => query.eq('threadId', run.threadId))
			.collect();
		const agentHistory: AgentHistoryMessage[] = buildCanonicalAgentHistory({
			messages,
			jobs
		});
		const prompt: string = findLatestPrompt(messages);

		return {
			run,
			threadRecord,
			prompt,
			agentHistory,
			workspaceSession
		};
	}
});

export const isFinished = query({
	args: {
		guestId: v.optional(v.string()),
		runId: v.id('runs')
	},
	handler: async (ctx, args): Promise<boolean> => {
		const userId: string = await getUserId(ctx, args.guestId);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		return isRunFinalStatus(run.status);
	}
});

export const getAssistantMessageState = internalQuery({
	args: {
		guestId: v.optional(v.string()),
		runId: v.id('runs')
	},
	handler: async (
		ctx,
		args
	): Promise<{
		text: string;
		parts: Doc<'threadMessages'>['parts'];
	} | null> => {
		const userId: string = await getUserId(ctx, args.guestId);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		if (!run.responseMessageId) {
			return null;
		}
		const message: Doc<'threadMessages'> | null = await ctx.db.get(run.responseMessageId);
		if (!message) {
			return null;
		}
		return {
			text: message.text,
			parts: message.parts
		};
	}
});

export const beginAssistantMessage = mutation({
	args: {
		guestId: v.optional(v.string()),
		runId: v.id('runs')
	},
	handler: async (ctx, args): Promise<void> => {
		const userId: string = await getUserId(ctx, args.guestId);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		const assistantMessage: Doc<'threadMessages'> | null = run.responseMessageId
			? await ctx.db.get(run.responseMessageId)
			: null;
		if (assistantMessage) {
			await ctx.db.patch(assistantMessage._id, {
				text: '',
				parts: undefined
			});
			return;
		}

		const messageId: Id<'threadMessages'> = await appendThreadMessage(ctx, {
			threadId: run.threadId,
			runId: args.runId,
			userId,
			type: 'response',
			text: ''
		});
		await ctx.db.patch(args.runId, {
			responseMessageId: messageId
		});
	}
});

export const updateAssistantMessage = internalMutation({
	args: {
		guestId: v.optional(v.string()),
		runId: v.id('runs'),
		text: v.string(),
		parts: v.array(vAssistantMessagePart)
	},
	handler: async (ctx, args): Promise<void> => {
		const userId: string = await getUserId(ctx, args.guestId);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		if (!run.responseMessageId) {
			return;
		}
		await ctx.db.patch(run.responseMessageId, {
			text: args.text,
			parts: args.parts.filter((part) => {
				if (part.type === 'text' || part.type === 'reasoning') {
					return part.text.trim().length > 0;
				}
				return true;
			})
		});
	}
});

export const finishAssistantMessage = mutation({
	args: {
		guestId: v.optional(v.string()),
		runId: v.id('runs'),
		text: v.string()
	},
	handler: async (ctx, args): Promise<void> => {
		const userId: string = await getUserId(ctx, args.guestId);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		if (!run.responseMessageId) {
			return;
		}
		const message: Doc<'threadMessages'> = await getThreadMessage(ctx, run.responseMessageId);
		const jobs: Doc<'executorJobs'>[] = await ctx.db
			.query('executorJobs')
			.withIndex('by_runId_sequence', (query) => query.eq('runId', message.runId))
			.collect();
		const nextParts: AssistantPart[] = ensureAssistantToolPartsFromJobs(
			(message.parts ?? []) as AssistantPart[],
			jobs
				.filter((job) => !job.hidden)
				.sort((left, right) => left.sequence - right.sequence)
				.map((job) => ({
					id: job._id,
					kind: job.kind,
					payload: job.payload,
					status: job.status,
					result: job.result,
					error: job.error
				}))
		);
		await ctx.db.patch(run.responseMessageId, {
			text: args.text,
			parts: nextParts
		});
	}
});

export const finishRun = mutation({
	args: {
		guestId: v.optional(v.string()),
		runId: v.id('runs'),
		status: vRunFinalStatus,
		lastError: v.optional(v.string())
	},
	handler: async (ctx, args): Promise<void> => {
		const userId: string = await getUserId(ctx, args.guestId);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		if (!isRunFinalStatus(run.status)) {
			const completedAt = Date.now();
			await ctx.db.patch(args.runId, {
				status: args.status,
				lastError: args.lastError,
				activeJobId: undefined,
				completedAt
			});
			if (run.activeJobId) {
				await ctx.db.patch(run.activeJobId, {
					status: args.status,
					error: args.lastError,
					completedAt
				});
			}
		}
	}
});

export const beginToolJob = mutation({
	args: {
		guestId: v.optional(v.string()),
		runId: v.id('runs'),
		kind: vExecutorJobKind,
		payload: vExecutorJobPayload,
		hidden: v.optional(v.boolean())
	},
	handler: async (
		ctx,
		args
	): Promise<{
		jobId: Id<'executorJobs'>;
		sequence: number;
	}> => {
		const userId: string = await getUserId(ctx, args.guestId);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		if (isRunFinalStatus(run.status)) {
			throw new Error('Run is no longer active.');
		}
		const workspaceSession: Doc<'workspaceSessions'> = await getOwnedWorkspaceSession(
			ctx.db,
			userId,
			run.workspaceSessionId
		);

		const nextSequence: number = workspaceSession.nextExecutorSequence ?? 0;
		await ctx.db.patch(workspaceSession._id, {
			nextExecutorSequence: nextSequence + 1
		});

		const jobId: Id<'executorJobs'> = await ctx.db.insert('executorJobs', {
			workspaceSessionId: run.workspaceSessionId,
			threadId: run.threadId,
			runId: args.runId,
			kind: args.kind,
			payload: args.payload,
			hidden: args.hidden ?? false,
			status: 'claimed',
			enqueuedAt: Date.now(),
			claimedAt: Date.now(),
			sequence: nextSequence
		});

		await ctx.db.patch(args.runId, {
			status: 'awaiting_executor',
			activeJobId: jobId
		});

		return {
			jobId,
			sequence: nextSequence
		};
	}
});
