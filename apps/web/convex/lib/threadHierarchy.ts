import type { Doc, Id } from '@convex/_generated/dataModel';
import type { DatabaseReader, MutationCtx, QueryCtx } from '@convex/_generated/server';
import { paginationOptsValidator } from 'convex/server';
import type { Infer } from 'convex/values';
import { isRunFinalStatus } from '@convex/lib/validators';
import { headActionablePendingQuestion } from '@convex/lib/agentQuestions';

async function latestRunActive(db: DatabaseReader, threadId: Id<'threadRecords'>) {
	const latest = await db
		.query('runs')
		.withIndex('by_threadId', (q) => q.eq('threadId', threadId))
		.order('desc')
		.first();

	return latest !== null && !isRunFinalStatus(latest.status);
}

async function waitingForInput(db: DatabaseReader, threadId: Id<'threadRecords'>) {
	return (await headActionablePendingQuestion(db, threadId)) !== null;
}

export async function threadOwnActivity(
	db: DatabaseReader,
	threadId: Id<'threadRecords'>
): Promise<boolean> {
	return (await latestRunActive(db, threadId)) || (await waitingForInput(db, threadId));
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
		descendantCount: 0,
		activeDescendantCount: 0,
		workingDescendantCount: 0
	};

	const state = { ...initial, _id: await ctx.db.insert('threadHierarchyStates', initial) };
	const thread = await ctx.db.get('threadRecords', threadId);

	if (!thread) throw new Error('Thread not found.');

	await addOwnActivityToAncestors(ctx, thread);

	return state;
}

async function addOwnActivityToAncestors(ctx: MutationCtx, thread: Doc<'threadRecords'>) {
	await applyAncestorCountChanges(ctx, thread, {
		total: 0,
		active: Number(await threadOwnActivity(ctx.db, thread._id)),
		working: Number(thread.status === 'running')
	});
}

async function applyAncestorCountChanges(
	ctx: MutationCtx,
	thread: Doc<'threadRecords'>,
	changes: { total: number; active: number; working: number }
): Promise<void> {
	if (changes.total === 0 && changes.active === 0 && changes.working === 0) return;

	for (const ancestor of await ancestorThreads(ctx.db, thread)) {
		const state = await ensureHierarchyState(ctx, ancestor._id);
		const descendantCount = state.descendantCount + changes.total;
		const activeDescendantCount = state.activeDescendantCount + changes.active;
		const workingCount = state.workingDescendantCount + changes.working;

		if (descendantCount < 0 || activeDescendantCount < 0 || workingCount < 0) {
			throw new Error('Invalid thread activity aggregate.');
		}

		await ctx.db.patch('threadHierarchyStates', state._id, {
			descendantCount,
			activeDescendantCount,
			workingDescendantCount: workingCount
		});
	}

	if (changes.active > 0) await unsettleRoot(ctx, thread);
}

export async function registerChildThread(ctx: MutationCtx, thread: Doc<'threadRecords'>) {
	await ensureHierarchyState(ctx, thread._id);
	await applyAncestorCountChanges(ctx, thread, {
		total: 1,
		active: 0,
		working: 0
	});
}

const threadsChangingActivity = new WeakMap<MutationCtx['db'], Set<Id<'threadRecords'>>>();

/**
 * Wrap every write to `threadRecords.status`, `runs.status`,
 * `runs.cancellationRequestedAt`, or `agentQuestions.status` so ancestor counters
 * follow it.
 */
export async function changeThreadActivity<T>(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>,
	change: () => Promise<T>
): Promise<T> {
	let changing = threadsChangingActivity.get(ctx.db);

	if (!changing) {
		changing = new Set();
		threadsChangingActivity.set(ctx.db, changing);
	}

	if (changing.has(threadId)) throw new Error('Thread activity changes must not nest.');
	changing.add(threadId);

	try {
		return await countActivityChange(ctx, threadId, change);
	} finally {
		changing.delete(threadId);
	}
}

async function countActivityChange<T>(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>,
	change: () => Promise<T>
): Promise<T> {
	const before = await ctx.db.get('threadRecords', threadId);

	if (!before) return await change();

	const wasActive = await threadOwnActivity(ctx.db, threadId);
	await ensureHierarchyState(ctx, threadId);

	const result = await change();
	const after = await ctx.db.get('threadRecords', threadId);

	if (after) {
		await applyAncestorCountChanges(ctx, after, {
			total: 0,
			active: Number(await threadOwnActivity(ctx.db, threadId)) - Number(wasActive),
			working: Number(after.status === 'running') - Number(before.status === 'running')
		});
	}

	return result;
}

export async function subtreeSummary(db: DatabaseReader, thread: Doc<'threadRecords'>) {
	const state = await hierarchyState(db, thread._id);
	const descendantsActive = (state?.activeDescendantCount ?? 0) > 0;
	const ownWaitingForInput = await waitingForInput(db, thread._id);

	return {
		descendantCount: state?.descendantCount ?? 0,
		workingDescendantCount: state?.workingDescendantCount ?? 0,
		anyActive: descendantsActive || ownWaitingForInput || (await latestRunActive(db, thread._id)),
		descendantsActive,
		waitingForInput: ownWaitingForInput
	};
}

export async function settleRoot(ctx: MutationCtx, root: Doc<'threadRecords'>): Promise<boolean> {
	if (root.parentThreadId !== undefined) throw new Error('Only root threads can be settled.');

	if (root.archivedAt !== undefined) return true;

	if ((await subtreeSummary(ctx.db, root)).anyActive) return false;

	await ctx.db.patch('threadRecords', root._id, { archivedAt: Date.now() });

	return true;
}

export async function unsettleRoot(ctx: MutationCtx, thread: Doc<'threadRecords'>) {
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
