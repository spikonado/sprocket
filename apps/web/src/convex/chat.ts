import type { Doc } from '@convex/_generated/dataModel';
import { mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedRun, getOwnedThreadRecord } from '@convex/lib/access';
import { getActorId, resolveActor } from '@convex/lib/auth';
import { enforceGuestSendLimit, enforceSignedInSendLimit } from '@convex/lib/rateLimits';
import { patchJobFinalState, patchRunFinalState } from '@convex/lib/state';
import { appendThreadMessage } from '@convex/lib/threadMessages';
import { isRunFinalStatus, vModelId, vReasoningEffort } from '@convex/lib/validators';

function summarizeJobPayload(job: Doc<'executorJobs'>): Doc<'executorJobs'>['payload'] {
	switch (job.kind) {
		case 'read_file':
		case 'create_file':
		case 'replace_in_file':
			return 'path' in job.payload ? { path: job.payload.path } : {};
		default:
			return {};
	}
}

function toLightweightJob(job: Doc<'executorJobs'>): Doc<'executorJobs'> {
	return {
		_id: job._id,
		_creationTime: job._creationTime,
		workspaceSessionId: job.workspaceSessionId,
		threadId: job.threadId,
		runId: job.runId,
		kind: job.kind,
		payload: summarizeJobPayload(job),
		hidden: job.hidden,
		status: job.status,
		enqueuedAt: job.enqueuedAt,
		claimedBy: job.claimedBy,
		claimedAt: job.claimedAt,
		completedAt: job.completedAt,
		error: job.error,
		sequence: job.sequence
	};
}

export const send = mutation({
	args: {
		guestId: v.optional(v.string()),
		threadId: v.string(),
		prompt: v.string(),
		selectedModel: vModelId,
		reasoningEffort: vReasoningEffort
	},
	handler: async (ctx, args) => {
		const actor = await resolveActor(ctx, args.guestId);
		if (actor.guestId) {
			await enforceGuestSendLimit(ctx, actor.guestId);
		} else {
			await enforceSignedInSendLimit(ctx, actor.ownerId);
		}

		const actorId: string = actor.ownerId;

		const threadRecord = await getOwnedThreadRecord(ctx.db, actorId, args.threadId);

		const prompt = args.prompt.trim();
		if (!prompt) {
			throw new Error('Prompt cannot be empty.');
		}

		const { messageId } = await appendThreadMessage(ctx, {
			threadId: args.threadId,
			role: 'user',
			status: 'success',
			text: prompt
		});
		const now = Date.now();
		const runId = await ctx.db.insert('runs', {
			threadId: args.threadId,
			userId: actorId,
			workspaceSessionId: threadRecord.workspaceSessionId,
			status: 'queued',
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			startedAt: now,
			promptMessageId: messageId
		});

		const nextTitle = threadRecord.lastMessagePreview ? threadRecord.title : prompt.slice(0, 72);
		await ctx.db.patch(threadRecord._id, {
			title: nextTitle,
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort
		});

		return {
			runId,
			promptMessageId: messageId
		};
	}
});

export const cancel = mutation({
	args: {
		guestId: v.optional(v.string()),
		runId: v.id('runs')
	},
	handler: async (ctx, args) => {
		const actorId: string = await getActorId(ctx, args.guestId);
		const run: Doc<'runs'> = await getOwnedRun(ctx.db, actorId, args.runId);

		if (isRunFinalStatus(run.status)) {
			return { cancelled: false };
		}

		await patchRunFinalState(ctx, args.runId, {
			status: 'cancelled'
		});
		if (run.activeJobId) {
			await patchJobFinalState(ctx, run.activeJobId, {
				status: 'cancelled',
				error: 'Cancelled by user.'
			});
		}

		return { cancelled: true };
	}
});

export const latestRunForThread = query({
	args: {
		guestId: v.optional(v.string()),
		threadId: v.string()
	},
	handler: async (ctx, args) => {
		const actorId: string = await getActorId(ctx, args.guestId);
		await getOwnedThreadRecord(ctx.db, actorId, args.threadId);

		const latestRun = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', args.threadId))
			.order('desc')
			.first();
		if (!latestRun) {
			return null;
		}

		const jobs = await ctx.db
			.query('executorJobs')
			.withIndex('by_runId_sequence', (query) => query.eq('runId', latestRun._id))
			.collect();

		return {
			...latestRun,
			jobs: jobs
				.filter((job) => !job.hidden)
				.sort((left, right) => left.sequence - right.sequence)
				.map(toLightweightJob)
		};
	}
});
