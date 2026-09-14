import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { v } from 'convex/values';
import { query, mutation, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import schema from './schema';
import { getUserId } from './lib/auth';
import { getOwnedThreadRecord } from './lib/access';
import { changeInboxState, patchInboxThread, wakeInboxThread } from './lib/inbox';
import { inboxState, vInboxState } from './lib/inboxState';
import { stream, mergedStream } from 'convex-helpers/server/stream';

export const list = query({
	args: {
		state: vInboxState,
		repositoryKeys: v.array(v.string()),
		paginationOpts: paginationOptsValidator
	},
	returns: paginationResultValidator(schema.doc('threadRecords')),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		if (args.repositoryKeys.length > 100)
			throw new Error('Select at most 100 projects, or use All projects.');
		if (args.repositoryKeys.length) {
			return await mergedStream(
				[...new Set(args.repositoryKeys)].map((key) =>
					stream(ctx.db, schema)
						.query('threadRecords')
						.withIndex('by_userId_repositoryKey_inboxState_inboxRunning_lastMessageAt', (q) =>
							q.eq('userId', userId).eq('repositoryKey', key).eq('inboxState', args.state)
						)
						.order('desc')
				),
				['inboxRunning', 'lastMessageAt', '_creationTime']
			).paginate(args.paginationOpts);
		}
		const rows = ctx.db
			.query('threadRecords')
			.withIndex('by_userId_and_inboxState_and_inboxRunning_and_lastMessageAt', (q) =>
				q.eq('userId', userId).eq('inboxState', args.state)
			)
			.order('desc');
		return await rows.paginate(args.paginationOpts);
	}
});

export const projects = query({
	args: {},
	returns: v.object({ projects: v.array(schema.doc('inboxProjects')), migrating: v.boolean() }),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		const [projects, legacy] = await Promise.all([
			ctx.db
				.query('inboxProjects')
				.withIndex('by_userId_and_repositoryKey', (q) => q.eq('userId', userId))
				.collect(),
			ctx.db
				.query('threadRecords')
				.withIndex('by_userId_and_inboxState_and_inboxRunning_and_lastMessageAt', (q) =>
					q.eq('userId', userId).eq('inboxState', undefined)
				)
				.first()
		]);
		return { projects, migrating: legacy !== null };
	}
});

export const changeState = mutation({
	args: {
		threadId: v.id('threadRecords'),
		state: vInboxState,
		snoozedUntil: v.optional(v.number()),
		expectedState: v.optional(vInboxState),
		expectedSnoozedUntil: v.optional(v.union(v.number(), v.null()))
	},
	returns: schema.doc('threadRecords'),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const thread = await getOwnedThreadRecord(ctx.db, userId, args.threadId);
		if (args.expectedState !== undefined && inboxState(thread) !== args.expectedState)
			throw new Error('Thread changed elsewhere. Try again.');
		if (
			args.expectedSnoozedUntil !== undefined &&
			(thread.snoozedUntil ?? null) !== args.expectedSnoozedUntil
		)
			throw new Error('Snooze changed elsewhere. Try again.');
		await changeInboxState(ctx, thread, args.state, args.snoozedUntil);
		return (await ctx.db.get('threadRecords', thread._id))!;
	}
});

export const setAutoSettle = mutation({
	args: { days: v.union(v.number(), v.null()) },
	returns: v.null(),
	handler: async (ctx, { days }) => {
		if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365))
			throw new Error('Choose between 1 and 365 days.');
		const userId = await getUserId(ctx);
		const settings = await ctx.db
			.query('uiPreferences')
			.withIndex('by_userId', (q) => q.eq('userId', userId))
			.unique();
		if (settings) await ctx.db.patch('uiPreferences', settings._id, { autoSettleDays: days });
		else await ctx.db.insert('uiPreferences', { userId, theme: 'dark', autoSettleDays: days });
		await ctx.scheduler.runAfter(0, internal.inbox.rescheduleUser, { userId });
		return null;
	}
});

export const maintain = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		const threads = await ctx.db
			.query('threadRecords')
			.withIndex('by_inboxState_and_inboxAutoSettleAt', (q) =>
				q.eq('inboxState', 'active').gt('inboxAutoSettleAt', 0).lte('inboxAutoSettleAt', now)
			)
			.take(100);
		for (const thread of threads) {
			const pending = await ctx.db
				.query('agentQuestions')
				.withIndex('by_threadId_status_sequence', (q) =>
					q.eq('threadId', thread._id).eq('status', 'pending')
				)
				.first();
			await patchInboxThread(ctx, thread, { hasPendingQuestion: pending !== null });
			const refreshed = (await ctx.db.get('threadRecords', thread._id))!;
			if (refreshed.inboxAutoSettleAt !== undefined && refreshed.inboxAutoSettleAt <= now) {
				await patchInboxThread(ctx, refreshed, { inboxState: 'settled' });
			}
		}
		if (threads.length === 100) await ctx.scheduler.runAfter(0, internal.inbox.maintain, {});
		return null;
	}
});

export const rescheduleUser = internalMutation({
	args: { userId: v.string(), cursor: v.optional(v.string()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const batch = await ctx.db
			.query('threadRecords')
			.withIndex('by_userId_and_inboxState_and_inboxRunning_and_lastMessageAt', (q) =>
				q.eq('userId', args.userId).eq('inboxState', 'active')
			)
			.paginate({ numItems: 100, cursor: args.cursor ?? null });
		for (const thread of batch.page) await patchInboxThread(ctx, thread, {});
		if (!batch.isDone)
			await ctx.scheduler.runAfter(0, internal.inbox.rescheduleUser, {
				userId: args.userId,
				cursor: batch.continueCursor
			});
		return null;
	}
});

export const wakeDue = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const threads = await ctx.db
			.query('threadRecords')
			.withIndex('by_inboxState_and_snoozedUntil', (q) =>
				q.eq('inboxState', 'snoozed').lte('snoozedUntil', Date.now())
			)
			.take(100);
		for (const thread of threads) await wakeInboxThread(ctx, thread);
		if (threads.length === 100) await ctx.scheduler.runAfter(0, internal.inbox.wakeDue, {});
		return null;
	}
});
