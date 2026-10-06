import type { Doc, Id } from '@convex/_generated/dataModel';
import type { DatabaseReader, MutationCtx, QueryCtx } from '@convex/_generated/server';
import { paginationOptsValidator } from 'convex/server';
import type { Infer } from 'convex/values';
import { isRunFinalStatus, type DescendantStatusCounts } from '@convex/lib/validators';
import { headActionablePendingQuestion } from '@convex/lib/agentQuestions';

const EMPTY_DESCENDANT_STATUS_COUNTS: DescendantStatusCounts = {
	queued: 0,
	running: 0,
	completed: 0,
	failed: 0,
	cancelled: 0
};

export async function threadOwnActivity(
	db: DatabaseReader,
	threadId: Id<'threadRecords'>
): Promise<boolean> {
	const latest = await db
		.query('runs')
		.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', threadId))
		.order('desc')
		.first();

	if (latest && !isRunFinalStatus(latest.status)) return true;

	return (await headActionablePendingQuestion(db, threadId)) !== null;
}

async function ancestorThreads(
	db: DatabaseReader,
	thread: Doc<'threadRecords'>
): Promise<Doc<'threadRecords'>[]> {
	const seen = new Set<string>([thread._id]);
	const ancestors: Doc<'threadRecords'>[] = [];
	let current = thread;

	while (current.parentThreadId !== undefined) {
		const parent = await db.get('threadRecords', current.parentThreadId);

		if (!parent || parent.userId !== thread.userId || seen.has(parent._id)) {
			throw new Error('Thread not found.');
		}

		seen.add(parent._id);
		ancestors.push(parent);
		current = parent;
	}

	return ancestors;
}

export async function threadRoot(
	db: DatabaseReader,
	thread: Doc<'threadRecords'>
): Promise<Doc<'threadRecords'>> {
	return (await ancestorThreads(db, thread)).at(-1) ?? thread;
}

export async function threadAncestryIds(
	db: DatabaseReader,
	thread: Doc<'threadRecords'>
): Promise<Id<'threadRecords'>[]> {
	return (await ancestorThreads(db, thread)).reverse().map((parent) => parent._id);
}

export async function assertDescendantThreadAccess(
	db: DatabaseReader,
	callerRun: Pick<Doc<'runs'>, 'threadId' | 'userId'>,
	targetThreadId: Id<'threadRecords'>
): Promise<Doc<'threadRecords'>> {
	const target = await db.get('threadRecords', targetThreadId);

	if (!target || target.userId !== callerRun.userId || target._id === callerRun.threadId) {
		throw new Error('Thread not found.');
	}

	const ancestors = await ancestorThreads(db, target);

	if (!ancestors.some((parent) => parent._id === callerRun.threadId)) {
		throw new Error('Thread not found.');
	}

	return target;
}

async function hierarchyState(db: DatabaseReader, threadId: Id<'threadRecords'>) {
	return await db
		.query('threadHierarchyStates')
		.withIndex('by_threadId', (q) => q.eq('threadId', threadId))
		.unique();
}

async function ensureHierarchyState(ctx: MutationCtx, threadId: Id<'threadRecords'>) {
	const existing = await hierarchyState(ctx.db, threadId);

	if (existing) return existing;

	const initial: Omit<Doc<'threadHierarchyStates'>, '_id' | '_creationTime'> = {
		threadId,
		ownActive: false,
		descendantCount: 0,
		activeDescendantCount: 0,
		descendantStatusCounts: EMPTY_DESCENDANT_STATUS_COUNTS
	};

	return { ...initial, _id: await ctx.db.insert('threadHierarchyStates', initial) };
}

export async function registerChildThread(ctx: MutationCtx, thread: Doc<'threadRecords'>) {
	for (const ancestor of await ancestorThreads(ctx.db, thread)) {
		const parentState = await ensureHierarchyState(ctx, ancestor._id);
		await ctx.db.patch('threadHierarchyStates', parentState._id, {
			descendantCount: parentState.descendantCount + 1
		});
	}

	await refreshThreadHierarchyActivity(ctx, thread._id);
}

export async function refreshThreadHierarchyActivity(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<void> {
	const thread = await ctx.db.get('threadRecords', threadId);

	if (!thread) return;

	const state = await ensureHierarchyState(ctx, threadId);
	const active = await threadOwnActivity(ctx.db, threadId);
	const activityDelta = Number(active) - Number(state.ownActive);
	const statusChanged = state.ownStatus !== thread.status;

	if (activityDelta === 0 && !statusChanged) return;

	for (const ancestor of await ancestorThreads(ctx.db, thread)) {
		const parentState = await ensureHierarchyState(ctx, ancestor._id);
		const count = parentState.activeDescendantCount + activityDelta;

		const statusCounts: DescendantStatusCounts = {
			...(parentState.descendantStatusCounts ?? EMPTY_DESCENDANT_STATUS_COUNTS)
		};

		if (count < 0) throw new Error('Invalid thread activity aggregate.');

		if (statusChanged) {
			if (state.ownStatus !== undefined) {
				statusCounts[state.ownStatus] -= 1;

				if (statusCounts[state.ownStatus] < 0) {
					throw new Error('Invalid thread status aggregate.');
				}
			}

			statusCounts[thread.status] += 1;
		}

		await ctx.db.patch('threadHierarchyStates', parentState._id, {
			activeDescendantCount: count,
			descendantStatusCounts: statusCounts
		});
	}

	await ctx.db.patch('threadHierarchyStates', state._id, {
		ownActive: active,
		ownStatus: thread.status,
		descendantStatusCounts: state.descendantStatusCounts ?? EMPTY_DESCENDANT_STATUS_COUNTS
	});

	if (activityDelta > 0) await unsettleRootOfThread(ctx, thread);
}

export async function subtreeSummary(db: DatabaseReader, thread: Doc<'threadRecords'>) {
	const state = await hierarchyState(db, thread._id);
	const descendantsActive = (state?.activeDescendantCount ?? 0) > 0;

	return {
		descendantCount: state?.descendantCount ?? 0,
		descendantStatusCounts: state?.descendantStatusCounts ?? EMPTY_DESCENDANT_STATUS_COUNTS,
		anyActive: descendantsActive || (await threadOwnActivity(db, thread._id)),
		descendantsActive
	};
}

export async function unsettleRootOfThread(ctx: MutationCtx, thread: Doc<'threadRecords'>) {
	const root = await threadRoot(ctx.db, thread);

	if (root.archivedAt !== undefined) {
		await ctx.db.patch('threadRecords', root._id, { archivedAt: undefined });
	}
}

export async function listDirectChildrenPage(
	ctx: QueryCtx | MutationCtx,
	userId: string,
	parentThreadId: Id<'threadRecords'>,
	paginationOpts: Infer<typeof paginationOptsValidator>
) {
	return await ctx.db
		.query('threadRecords')
		.withIndex('by_userId_and_parentThreadId_and_lastMessageAt', (q) =>
			q.eq('userId', userId).eq('parentThreadId', parentThreadId)
		)
		.order('desc')
		.paginate(paginationOpts);
}
