import { mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import {
	getOwnedRun,
	getOwnedThreadRecord,
	getOwnedWorkspaceSession,
	getThreadRecordByThreadId
} from '@convex/lib/access';
import { getActorId } from '@convex/lib/auth';
import { patchRunFinalState } from '@convex/lib/state';
import {
	appendThreadMessage,
	getThreadMessage,
	listThreadMessages
} from '@convex/lib/threadMessages';
import {
	isRunFinalStatus,
	vExecutorJobKind,
	vExecutorJobPayload,
	vRunFinalStatus,
	vThreadMessageStatus
} from '@convex/lib/validators';
import { Doc } from './_generated/dataModel';

export const start = mutation({
	args: {
		guestId: v.optional(v.string()),
		runId: v.id('runs')
	},
	handler: async (ctx, args) => {
		const actorId: string = await getActorId(ctx, args.guestId);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, actorId, args.runId);
		if (isRunFinalStatus(run.status)) {
			return run;
		}

		await ctx.db.patch(args.runId, {
			status: 'running',
			lastError: undefined
		});

		return await ctx.db.get(args.runId);
	}
});

export const getContext = query({
	args: {
		guestId: v.optional(v.string()),
		runId: v.id('runs')
	},
	handler: async (ctx, args) => {
		const actorId: string = await getActorId(ctx, args.guestId);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, actorId, args.runId);
		const threadRecord: Doc<'threadRecords'> = await getOwnedThreadRecord(
			ctx.db,
			actorId,
			run.threadId
		);
		const workspaceSession: Doc<'workspaceSessions'> = await getOwnedWorkspaceSession(
			ctx.db,
			actorId,
			run.workspaceSessionId
		);
		const messages: Doc<'threadMessage'>[] = await listThreadMessages(ctx, run.threadId);

		return {
			run,
			threadRecord,
			workspaceSession,
			messages: messages.sort((left, right) => {
				if (left.order !== right.order) {
					return left.order - right.order;
				}
				return left.stepOrder - right.stepOrder;
			})
		};
	}
});

export const isFinished = query({
	args: {
		guestId: v.optional(v.string()),
		runId: v.id('runs')
	},
	handler: async (ctx, args) => {
		const actorId: string = await getActorId(ctx, args.guestId);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, actorId, args.runId);
		return isRunFinalStatus(run.status);
	}
});

export const beginAssistantMessage = mutation({
	args: {
		guestId: v.optional(v.string()),
		runId: v.id('runs')
	},
	handler: async (ctx, args) => {
		const actorId: string = await getActorId(ctx, args.guestId);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, actorId, args.runId);
		const existing: Doc<'threadMessage'>[] = await ctx.db
			.query('threadMessage')
			.withIndex('by_runId', (query) => query.eq('runId', args.runId))
			.collect();
		const assistantMessage: Doc<'threadMessage'> | undefined = existing.find(
			(message) => message.role === 'assistant'
		);
		if (assistantMessage) {
			await ctx.db.patch(assistantMessage._id, {
				status: 'streaming',
				text: ''
			});
			return assistantMessage;
		}

		const { messageId } = await appendThreadMessage(ctx, {
			threadId: run.threadId,
			runId: args.runId,
			role: 'assistant',
			status: 'streaming',
			text: '',
			agentName: 'Sprocket'
		});
		return await getThreadMessage(ctx, messageId);
	}
});

export const updateAssistantMessage = mutation({
	args: {
		guestId: v.optional(v.string()),
		messageId: v.id('threadMessage'),
		text: v.string(),
		status: v.optional(vThreadMessageStatus)
	},
	handler: async (ctx, args) => {
		const actorId: string = await getActorId(ctx, args.guestId);
		const message: Doc<'threadMessage'> = await getThreadMessage(ctx, args.messageId);
		await getOwnedThreadRecord(ctx.db, actorId, message.threadId);
		await ctx.db.patch(args.messageId, {
			text: args.text,
			...(args.status ? { status: args.status } : {})
		});
	}
});

export const finishAssistantMessage = mutation({
	args: {
		guestId: v.optional(v.string()),
		messageId: v.id('threadMessage'),
		text: v.string(),
		status: v.union(v.literal('success'), v.literal('failed'))
	},
	handler: async (ctx, args) => {
		const actorId: string = await getActorId(ctx, args.guestId);
		const message: Doc<'threadMessage'> = await getThreadMessage(ctx, args.messageId);
		await getOwnedThreadRecord(ctx.db, actorId, message.threadId);
		await ctx.db.patch(args.messageId, {
			text: args.text,
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
	handler: async (ctx, args) => {
		const actorId = await getActorId(ctx, args.guestId);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, actorId, args.runId);
		if (!isRunFinalStatus(run.status)) {
			await patchRunFinalState(ctx, args.runId, {
				status: args.status,
				lastError: args.lastError
			});
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
	handler: async (ctx, args) => {
		const actorId = await getActorId(ctx, args.guestId);
		const run = await getOwnedRun(ctx.db, actorId, args.runId);
		if (isRunFinalStatus(run.status)) {
			throw new Error('Run is no longer active.');
		}
		const workspaceSession = await getOwnedWorkspaceSession(
			ctx.db,
			actorId,
			run.workspaceSessionId
		);
		const threadRecord = await getThreadRecordByThreadId(ctx.db, run.threadId);
		if (!threadRecord) {
			throw new Error('Thread not found.');
		}

		const nextSequence = workspaceSession.nextExecutorSequence ?? 0;
		const now = Date.now();
		await ctx.db.patch(workspaceSession._id, {
			nextExecutorSequence: nextSequence + 1
		});

		const jobId = await ctx.db.insert('executorJobs', {
			workspaceSessionId: run.workspaceSessionId,
			threadId: run.threadId,
			runId: args.runId,
			kind: args.kind,
			payload: args.payload,
			hidden: args.hidden ?? false,
			status: 'claimed',
			enqueuedAt: now,
			claimedAt: now,
			claimedBy: 'native',
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
