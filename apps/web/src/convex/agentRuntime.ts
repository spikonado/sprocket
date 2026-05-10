import type { Doc, Id } from '@convex/_generated/dataModel';
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx
} from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedRun, getOwnedThreadRecord, getOwnedWorkspaceSession } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { shouldIncludeMessageInCanonicalAgentHistory } from '@convex/lib/agentHistory';
import { patchJobFinalState, patchRunFinalState } from '@convex/lib/state';
import {
	appendThreadMessage,
	getThreadMessage,
	listThreadMessages
} from '@convex/lib/threadMessages';
import { ensureAssistantToolPartsFromJobs, type AssistantPart } from '../lib/assistant-tool-parts';
import {
	type AgentHistoryMessage,
	isRunFinalStatus,
	vExecutorJobKind,
	vExecutorJobPayload,
	vRunFinalStatus,
	vAssistantMessagePart,
	vThreadMessageFinalStatus
} from '@convex/lib/validators';

function compareThreadMessages(left: Doc<'threadMessages'>, right: Doc<'threadMessages'>) {
	if (left.order !== right.order) {
		return left.order - right.order;
	}
	return left.stepOrder - right.stepOrder;
}

function buildAgentHistoryFromAssistantMessage(args: {
	message: Doc<'threadMessages'>;
	jobs: Doc<'executorJobs'>[];
}): AgentHistoryMessage[] {
	const persistedParts = (args.message.parts ?? []) as AssistantPart[];
	const shouldRebuildToolPartsFromJobs = args.message.status !== 'success';
	const baseParts = shouldRebuildToolPartsFromJobs
		? persistedParts.filter((part) => part.type === 'text' || part.type === 'reasoning')
		: persistedParts;
	const parts = ensureAssistantToolPartsFromJobs(
		baseParts,
		args.jobs
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
	const history: AgentHistoryMessage[] = [];
	let assistantContents: AgentHistoryMessage['contents'] = [];
	let sawAssistantTextPart = false;

	const flushAssistantContents = () => {
		if (assistantContents.length === 0) {
			return;
		}
		history.push({
			role: 'assistant',
			contents: assistantContents
		});
		assistantContents = [];
	};

	for (const part of parts) {
		if (part.type === 'text') {
			if (part.text.trim().length === 0) {
				continue;
			}
			sawAssistantTextPart = true;
			assistantContents.push({
				type: 'text',
				text: part.text
			});
			continue;
		}

		if (part.type === 'reasoning') {
			continue;
		}

		if (part.type === 'tool-call') {
			assistantContents.push({
				type: 'toolCall',
				callId: part.callId,
				name: part.name,
				argumentsJson: JSON.stringify(part.input)
			});
			continue;
		}

		flushAssistantContents();
		history.push({
			role: 'user',
			contents: [
				{
					type: 'toolResult',
					callId: part.callId,
					items: [
						{
							type: 'text',
							text: JSON.stringify(part.output)
						}
					]
				}
			]
		});
	}

	if (!sawAssistantTextPart && args.message.text.trim().length > 0) {
		assistantContents.push({
			type: 'text',
			text: args.message.text
		});
	}

	flushAssistantContents();
	return history;
}

async function buildCanonicalAgentHistory(
	ctx: MutationCtx | QueryCtx,
	threadId: Id<'threadRecords'>
): Promise<AgentHistoryMessage[]> {
	const messages = (await listThreadMessages(ctx, threadId)).slice().sort(compareThreadMessages);
	const runIds = [...new Set(messages.map((message) => message.runId))];
	const runs = await Promise.all(runIds.map(async (runId) => await ctx.db.get(runId)));
	const runStatusById = new Map(
		runs.filter((run): run is Doc<'runs'> => run !== null).map((run) => [run._id, run.status])
	);
	const canonicalMessages = messages.filter((message) => {
		if (message.role !== 'user' && message.role !== 'assistant') {
			return false;
		}
		return shouldIncludeMessageInCanonicalAgentHistory({
			role: message.role,
			messageStatus: message.status,
			runStatus: runStatusById.get(message.runId) ?? null
		});
	});
	const jobs = await ctx.db
		.query('executorJobs')
		.withIndex('by_threadId_sequence', (query) => query.eq('threadId', threadId))
		.collect();
	const jobsByRunId = new Map<Id<'runs'>, Doc<'executorJobs'>[]>();
	for (const job of jobs) {
		const runJobs = jobsByRunId.get(job.runId) ?? [];
		runJobs.push(job);
		jobsByRunId.set(job.runId, runJobs);
	}

	const history: AgentHistoryMessage[] = [];
	for (const message of canonicalMessages) {
		if (message.role === 'user') {
			const text = message.text.trim();
			if (text.length === 0) {
				continue;
			}
			history.push({
				role: 'user',
				contents: [
					{
						type: 'text',
						text
					}
				]
			});
			continue;
		}

		history.push(
			...buildAgentHistoryFromAssistantMessage({
				message,
				jobs: jobsByRunId.get(message.runId) ?? []
			})
		);
	}

	return history;
}

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
		agentHistory: AgentHistoryMessage[];
		messages: Doc<'threadMessages'>[];
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
		const messages: Doc<'threadMessages'>[] = await listThreadMessages(ctx, run.threadId);
		const agentHistory = await buildCanonicalAgentHistory(ctx, run.threadId);

		return {
			run,
			threadRecord,
			agentHistory,
			workspaceSession,
			messages: messages.sort(compareThreadMessages)
		};
	}
});

export const isFinished = query({
	args: {
		guestId: v.optional(v.string()),
		runId: v.optional(v.id('runs'))
	},
	handler: async (ctx, args): Promise<boolean> => {
		const userId: string = await getUserId(ctx, args.guestId);
		if (args.runId) {
			const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
			return isRunFinalStatus(run.status);
		}
		return false;
	}
});

export const getAssistantMessage = internalQuery({
	args: {
		guestId: v.optional(v.string()),
		messageId: v.id('threadMessages')
	},
	handler: async (ctx, args): Promise<Doc<'threadMessages'>> => {
		const userId: string = await getUserId(ctx, args.guestId);
		const message: Doc<'threadMessages'> = await getThreadMessage(ctx, args.messageId);
		await getOwnedThreadRecord(ctx.db, userId, message.threadId);
		return message;
	}
});

export const beginAssistantMessage = mutation({
	args: {
		guestId: v.optional(v.string()),
		runId: v.id('runs')
	},
	handler: async (ctx, args): Promise<Id<'threadMessages'>> => {
		const userId: string = await getUserId(ctx, args.guestId);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, userId, args.runId);
		const assistantMessage: Doc<'threadMessages'> | null = await ctx.db
			.query('threadMessages')
			.withIndex('by_runId_role', (query) => query.eq('runId', args.runId).eq('role', 'assistant'))
			.unique();
		if (assistantMessage) {
			await ctx.db.patch(assistantMessage._id, {
				status: 'streaming',
				text: ''
			});
			return assistantMessage._id;
		}

		const messageId: Id<'threadMessages'> = (
			await appendThreadMessage(ctx, {
				threadId: run.threadId,
				runId: args.runId,
				role: 'assistant',
				status: 'streaming',
				text: '',
				agentName: 'Sprocket'
			})
		).messageId;
		return messageId;
	}
});

export const updateAssistantMessage = internalMutation({
	args: {
		messageId: v.optional(v.id('threadMessages')),
		text: v.string(),
		parts: v.array(vAssistantMessagePart)
	},
	handler: async (ctx, args): Promise<void> => {
		if (args.messageId) {
			await ctx.db.patch(args.messageId, {
				text: args.text,
				parts: args.parts.filter((part) => {
					if (part.type === 'text' || part.type === 'reasoning') {
						return part.text.trim().length > 0;
					}
					return true;
				})
			});
		}
	}
});

export const finishAssistantMessage = mutation({
	args: {
		messageId: v.id('threadMessages'),
		text: v.string(),
		status: vThreadMessageFinalStatus
	},
	handler: async (ctx, args): Promise<void> => {
		const message: Doc<'threadMessages'> = await getThreadMessage(ctx, args.messageId);
		const nextText =
			args.text.trim().length === 0 && message.text.trim().length > 0 ? message.text : args.text;
		const jobs: Doc<'executorJobs'>[] = await ctx.db
			.query('executorJobs')
			.withIndex('by_runId_sequence', (query) => query.eq('runId', message.runId))
			.collect();
		const nextParts = ensureAssistantToolPartsFromJobs(
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
		await ctx.db.patch(args.messageId, {
			text: nextText,
			parts: nextParts,
			status: args.status,
			completedAt: Date.now()
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
			await patchRunFinalState(ctx, args.runId, {
				status: args.status,
				lastError: args.lastError
			});
			if (run.activeJobId) {
				await patchJobFinalState(ctx, run.activeJobId, {
					status: args.status,
					error: args.lastError
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
