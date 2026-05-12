import { internalMutation, internalQuery, mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedExecutorJob, getOwnedWorkspaceSession } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import {
	isRunFinalStatus,
	vExecutorJobKind,
	vExecutorJobPayload,
	vExecutorJobResult,
	vRunFinalStatus
} from '@convex/lib/validators';
import {
	canClientClaimWorkspaceSession,
	getAttachedWorkspaceSessionsForClient,
	withEffectiveWorkspaceSessionState
} from '@convex/lib/workspaceConnection';

export const listPending = query({
	args: {
		guestId: v.optional(v.string()),
		workspaceSessionId: v.id('workspaceSessions')
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		await getOwnedWorkspaceSession(ctx.db, userId, args.workspaceSessionId);

		const [pendingJobs, claimedJobs] = await Promise.all([
			ctx.db
				.query('executorJobs')
				.withIndex('by_workspaceSessionId_status_sequence', (query) =>
					query.eq('workspaceSessionId', args.workspaceSessionId).eq('status', 'pending')
				)
				.collect(),
			ctx.db
				.query('executorJobs')
				.withIndex('by_workspaceSessionId_status_sequence', (query) =>
					query.eq('workspaceSessionId', args.workspaceSessionId).eq('status', 'claimed')
				)
				.collect()
		]);

		return [...pendingJobs, ...claimedJobs].sort((left, right) => left.sequence - right.sequence);
	}
});

export const listPendingForClient = query({
	args: {
		guestId: v.optional(v.string()),
		clientId: v.string()
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		const now = Date.now();
		const workspaceSessions = await ctx.db
			.query('workspaceSessions')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.collect();
		const attachedSessionIds = getAttachedWorkspaceSessionsForClient(
			workspaceSessions,
			args.clientId,
			now
		).map((workspaceSession) => workspaceSession._id);

		const jobs = (
			await Promise.all(
				attachedSessionIds.map(async (workspaceSessionId) => {
					const [pendingJobs, claimedJobs] = await Promise.all([
						ctx.db
							.query('executorJobs')
							.withIndex('by_workspaceSessionId_status_sequence', (query) =>
								query.eq('workspaceSessionId', workspaceSessionId).eq('status', 'pending')
							)
							.collect(),
						ctx.db
							.query('executorJobs')
							.withIndex('by_workspaceSessionId_status_sequence', (query) =>
								query.eq('workspaceSessionId', workspaceSessionId).eq('status', 'claimed')
							)
							.collect()
					]);
					return [...pendingJobs, ...claimedJobs];
				})
			)
		).flat();

		return jobs.sort((left, right) => {
			if (left.workspaceSessionId !== right.workspaceSessionId) {
				return left.workspaceSessionId.localeCompare(right.workspaceSessionId);
			}
			return left.sequence - right.sequence;
		});
	}
});

export const claim = mutation({
	args: {
		guestId: v.optional(v.string()),
		jobId: v.id('executorJobs'),
		clientId: v.string()
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		const job = await getOwnedExecutorJob(ctx.db, userId, args.jobId);
		const run = await ctx.db.get(job.runId);
		if (!run || isRunFinalStatus(run.status)) {
			return null;
		}
		const workspaceSession = await getOwnedWorkspaceSession(ctx.db, userId, job.workspaceSessionId);
		if (!canClientClaimWorkspaceSession(workspaceSession, args.clientId)) {
			return null;
		}

		if (job.status === 'claimed') {
			return job;
		}
		if (job.status !== 'pending') {
			return null;
		}

		const now = Date.now();
		await ctx.db.patch(args.jobId, {
			status: 'claimed',
			claimedAt: now
		});
		await ctx.db.patch(job.runId, {
			status: 'awaiting_executor',
			activeJobId: args.jobId
		});

		return await ctx.db.get(args.jobId);
	}
});

export const complete = mutation({
	args: {
		guestId: v.optional(v.string()),
		jobId: v.id('executorJobs'),
		result: vExecutorJobResult
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		const job = await getOwnedExecutorJob(ctx.db, userId, args.jobId);
		const run = await ctx.db.get(job.runId);
		if (job.status === 'cancelled' || job.status === 'failed') {
			return false;
		}
		if (job.status === 'completed') {
			return true;
		}
		if (!run || isRunFinalStatus(run.status)) {
			return false;
		}

		await ctx.db.patch(args.jobId, {
			status: 'completed',
			result: args.result,
			completedAt: Date.now()
		});
		await ctx.db.patch(run._id, {
			status: 'running',
			activeJobId: undefined
		});
		return true;
	}
});

export const fail = mutation({
	args: {
		guestId: v.optional(v.string()),
		jobId: v.id('executorJobs'),
		error: v.string()
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		const job = await getOwnedExecutorJob(ctx.db, userId, args.jobId);
		if (job.status === 'cancelled' || job.status === 'completed' || job.status === 'failed') {
			return false;
		}

		const completedAt = Date.now();
		await ctx.db.patch(args.jobId, {
			status: 'failed',
			error: args.error,
			completedAt
		});
		await ctx.db.patch(job.runId, {
			status: 'failed',
			lastError: args.error,
			activeJobId: undefined,
			completedAt
		});
		return true;
	}
});

export const getRunForInternal = internalQuery({
	args: {
		runId: v.id('runs')
	},
	handler: async (ctx, args) => {
		return await ctx.db.get(args.runId);
	}
});

export const getWorkspaceSessionForInternal = internalQuery({
	args: {
		workspaceSessionId: v.id('workspaceSessions')
	},
	handler: async (ctx, args) => {
		const workspaceSession = await ctx.db.get(args.workspaceSessionId);
		return workspaceSession ? withEffectiveWorkspaceSessionState(workspaceSession) : null;
	}
});

export const getJobForInternal = internalQuery({
	args: {
		jobId: v.id('executorJobs')
	},
	handler: async (ctx, args) => {
		return await ctx.db.get(args.jobId);
	}
});

export const enqueueJob = internalMutation({
	args: {
		workspaceSessionId: v.id('workspaceSessions'),
		threadId: v.id('threadRecords'),
		runId: v.id('runs'),
		kind: vExecutorJobKind,
		payload: vExecutorJobPayload,
		hidden: v.optional(v.boolean())
	},
	handler: async (ctx, args) => {
		const workspaceSession = await ctx.db.get(args.workspaceSessionId);
		if (!workspaceSession) {
			throw new Error('Workspace session not found.');
		}
		const run = await ctx.db.get(args.runId);
		if (!run) {
			throw new Error('Run not found.');
		}
		if (isRunFinalStatus(run.status)) {
			throw new Error('Run is no longer active.');
		}

		const nextSequence = workspaceSession.nextExecutorSequence ?? 0;
		const now = Date.now();
		await ctx.db.patch(args.workspaceSessionId, {
			nextExecutorSequence: nextSequence + 1
		});

		const jobId = await ctx.db.insert('executorJobs', {
			workspaceSessionId: args.workspaceSessionId,
			threadId: args.threadId,
			runId: args.runId,
			kind: args.kind,
			payload: args.payload,
			hidden: args.hidden ?? false,
			status: 'pending',
			enqueuedAt: now,
			sequence: nextSequence
		});
		await ctx.db.patch(args.runId, {
			status: 'awaiting_executor',
			activeJobId: jobId
		});
		return jobId;
	}
});

export const markRunRunning = internalMutation({
	args: {
		runId: v.id('runs')
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.runId, {
			status: 'running'
		});
	}
});

export const finishRun = internalMutation({
	args: {
		runId: v.id('runs'),
		status: vRunFinalStatus,
		lastError: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.runId, {
			status: args.status,
			lastError: args.lastError,
			activeJobId: undefined,
			completedAt: Date.now()
		});
	}
});

export const cancelJob = internalMutation({
	args: {
		jobId: v.id('executorJobs'),
		error: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const job = await ctx.db.get(args.jobId);
		if (!job) {
			return;
		}
		if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
			return;
		}

		await ctx.db.patch(args.jobId, {
			status: 'cancelled',
			error: args.error,
			completedAt: Date.now()
		});

		const run = await ctx.db.get(job.runId);
		if (!run || run.activeJobId !== args.jobId) {
			return;
		}
		if (isRunFinalStatus(run.status)) {
			return;
		}

		await ctx.db.patch(job.runId, {
			status: 'running',
			activeJobId: undefined
		});
	}
});
