import type { Doc, Id } from '@convex/_generated/dataModel';
import { mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { enforceGuestSendLimit, enforceSignedInSendLimit } from '@convex/lib/rateLimits';
import { appendThreadMessage } from '@convex/lib/threadMessages';
import { vModelId, vReasoningEffort } from '@convex/lib/validators';

export const send = mutation({
	args: {
		guestId: v.optional(v.string()),
		threadId: v.string(),
		prompt: v.string(),
		selectedModel: vModelId,
		reasoningEffort: vReasoningEffort
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		if (userId.startsWith('guest:')) {
			await enforceGuestSendLimit(ctx, userId);
		} else {
			await enforceSignedInSendLimit(ctx, userId);
		}

		const threadRecord: Doc<'threadRecords'> = await getOwnedThreadRecord(
			ctx.db,
			userId,
			args.threadId
		);
		const prompt = args.prompt.trim();

		const messageId: Id<'threadMessages'> = (
			await appendThreadMessage(ctx, {
				threadId: args.threadId,
				role: 'user',
				status: 'success',
				text: prompt
			})
		).messageId;
		const runId: Id<'runs'> = await ctx.db.insert('runs', {
			threadId: args.threadId,
			userId,
			workspaceSessionId: threadRecord.workspaceSessionId,
			status: 'queued',
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			startedAt: Date.now(),
			promptMessageId: messageId
		});

		await ctx.db.patch(threadRecord._id, {
			title: threadRecord.title ?? prompt.slice(0, 72),
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort
		});

		return {
			runId,
			promptMessageId: messageId
		};
	}
});

export const latestRunForThread = query({
	args: {
		guestId: v.optional(v.string()),
		threadId: v.string()
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		const latestRun: Doc<'runs'> | null = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', args.threadId))
			.order('desc')
			.first();
		if (!latestRun) {
			return null;
		}

		const jobs: Doc<'executorJobs'>[] = await ctx.db
			.query('executorJobs')
			.withIndex('by_runId_sequence', (query) => query.eq('runId', latestRun._id))
			.collect();

		return {
			...latestRun,
			jobs: jobs.filter((job) => !job.hidden).sort((left, right) => left.sequence - right.sequence)
		};
	}
});
