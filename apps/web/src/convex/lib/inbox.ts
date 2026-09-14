import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { inboxState, runningStatus, type InboxState } from './inboxState';
import { internal } from '../_generated/api';

async function adjustCount(
	ctx: MutationCtx,
	userId: string,
	repositoryKey: string,
	state: InboxState,
	delta: number
) {
	const project = await ctx.db
		.query('inboxProjects')
		.withIndex('by_userId_and_repositoryKey', (q) =>
			q.eq('userId', userId).eq('repositoryKey', repositoryKey)
		)
		.unique();
	if (project) {
		await ctx.db.patch('inboxProjects', project._id, { [state]: project[state] + delta });
	} else {
		if (delta < 0) throw new Error('Missing inbox project count.');
		await ctx.db.insert('inboxProjects', {
			userId,
			repositoryKey,
			active: 0,
			pinned: 0,
			snoozed: 0,
			settled: 0,
			[state]: delta
		});
	}
}

export async function patchInboxThread(
	ctx: MutationCtx,
	previous: Pick<Doc<'threadRecords'>, '_id'>,
	patch: Partial<Omit<Doc<'threadRecords'>, '_id' | '_creationTime' | 'userId'>>
) {
	const thread = await ctx.db.get('threadRecords', previous._id);
	if (!thread) throw new Error('Thread not found.');
	if (thread.inboxState === undefined) {
		const [run, pending] = await Promise.all([
			ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', thread._id))
				.order('desc')
				.first(),
			ctx.db
				.query('agentQuestions')
				.withIndex('by_threadId_status_sequence', (q) =>
					q.eq('threadId', thread._id).eq('status', 'pending')
				)
				.first()
		]);
		patch = {
			status: run?.status ?? thread.status ?? 'completed',
			lastCompletedAt: run?.completedAt,
			lastRunStartedAt: run?.startedAt,
			hasPendingQuestion: pending !== null,
			...patch
		};
	}
	const next = { ...thread, ...patch };
	const state = inboxState(next);
	const oldState = inboxState(thread);
	const preferences = await ctx.db
		.query('uiPreferences')
		.withIndex('by_userId', (q) => q.eq('userId', thread.userId))
		.unique();
	const days = preferences?.autoSettleDays === undefined ? 7 : preferences.autoSettleDays;
	const inboxAutoSettleAt =
		state === 'active' && !runningStatus(next.status) && !next.hasPendingQuestion && days !== null
			? Math.max(next.lastMessageAt, next.lastCompletedAt ?? 0, next.inboxActiveAt ?? 0) +
				days * 86_400_000
			: undefined;
	if (
		thread.inboxState === undefined ||
		state !== oldState ||
		next.repositoryKey !== thread.repositoryKey
	) {
		if (thread.inboxState !== undefined) {
			await adjustCount(ctx, thread.userId, thread.repositoryKey, oldState, -1);
		}
		await adjustCount(ctx, thread.userId, next.repositoryKey, state, 1);
	}
	const updates = {
		...patch,
		inboxState: state,
		inboxAutoSettleAt,
		inboxRunning: (state === 'active' || state === 'pinned') && runningStatus(next.status),
		archivedAt: state === 'settled' ? (next.archivedAt ?? Date.now()) : undefined,
		snoozedUntil: state === 'snoozed' ? next.snoozedUntil : undefined
	};
	// SAFETY: updates contains only threadRecords fields, including explicit undefined removals.
	if (
		Object.entries(updates).some(([key, value]) => thread[key as keyof typeof thread] !== value)
	) {
		await ctx.db.patch('threadRecords', thread._id, updates);
	}
}

export async function changeInboxState(
	ctx: MutationCtx,
	thread: Doc<'threadRecords'>,
	state: InboxState,
	snoozedUntil?: number
) {
	if (thread.inboxState === undefined) {
		await patchInboxThread(ctx, thread, {});
		thread = (await ctx.db.get('threadRecords', thread._id))!;
	}
	const previous = inboxState(thread);
	if (previous === state && (state !== 'snoozed' || snoozedUntil === thread.snoozedUntil)) return;
	if (previous === 'pinned' && (state === 'settled' || state === 'snoozed')) {
		throw new Error('Unpin this thread first.');
	}
	const pending = await ctx.db
		.query('agentQuestions')
		.withIndex('by_threadId_status_sequence', (q) =>
			q.eq('threadId', thread._id).eq('status', 'pending')
		)
		.first();
	if ((state === 'settled' || state === 'snoozed') && pending) {
		throw new Error('This thread is waiting for your answer.');
	}
	if (state === 'settled' && runningStatus(thread.status)) {
		throw new Error('Cannot settle a thread while a run is active.');
	}
	const now = Date.now();
	if (
		state === 'snoozed' &&
		(!snoozedUntil || !Number.isFinite(snoozedUntil) || snoozedUntil <= now)
	) {
		throw new Error('Choose a future wake time.');
	}
	await patchInboxThread(ctx, thread, {
		inboxState: state,
		snoozedUntil,
		inboxActiveAt: state === 'active' ? now : thread.inboxActiveAt,
		lastMessageAt: previous === 'settled' && state === 'active' ? now : thread.lastMessageAt,
		wokeAt: previous === 'snoozed' && state === 'active' ? now : undefined
	});
	if (state === 'snoozed') await ctx.scheduler.runAt(snoozedUntil!, internal.inbox.wakeDue, {});
}

export async function wakeInboxThread(
	ctx: MutationCtx,
	thread: Doc<'threadRecords'>,
	at = Date.now()
) {
	if (inboxState(thread) !== 'snoozed') return;
	await patchInboxThread(ctx, thread, { inboxState: 'active', inboxActiveAt: at, wokeAt: at });
}
