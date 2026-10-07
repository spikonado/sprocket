import type { Doc, Id } from '@convex/_generated/dataModel';
import type { DatabaseReader, MutationCtx, QueryCtx } from '@convex/_generated/server';
import { paginationOptsValidator } from 'convex/server';
import type { Infer } from 'convex/values';
import { isRunFinalStatus } from '@convex/lib/validators';
import { headActionablePendingQuestion } from '@convex/lib/agentQuestions';

function workingDescendantCount(
	state: Pick<
		Doc<'threadHierarchyStates'>,
		'workingDescendantCount' | 'descendantStatusCounts'
	> | null
): number {
	return state?.workingDescendantCount ?? state?.descendantStatusCounts?.running ?? 0;
}

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
		descendantCount: 0,
		activeDescendantCount: 0,
		workingDescendantCount: 0
	};

	const state = { ...initial, _id: await ctx.db.insert('threadHierarchyStates', initial) };
	const thread = await ctx.db.get('threadRecords', threadId);

	if (!thread) throw new Error('Thread not found.');

	// A newly initialized ancestor has no stored contribution to reconcile later.
	await applyAncestorCountChanges(ctx, thread, {
		total: 0,
		active: Number(await threadOwnActivity(ctx.db, threadId)),
		working: Number(thread.status === 'running')
	});

	return state;
}

type ThreadActivity = {
	thread: Doc<'threadRecords'>;
	active: boolean;
};

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
		const workingCount = workingDescendantCount(state) + changes.working;

		if (descendantCount < 0 || activeDescendantCount < 0 || workingCount < 0) {
			throw new Error('Invalid thread activity aggregate.');
		}

		await ctx.db.patch('threadHierarchyStates', state._id, {
			descendantCount,
			activeDescendantCount,
			workingDescendantCount: workingCount,
			descendantStatusCounts: undefined
		});
	}

	if (changes.active > 0) await unsettleRootOfThread(ctx, thread);
}

export async function registerChildThread(ctx: MutationCtx, thread: Doc<'threadRecords'>) {
	await ensureHierarchyState(ctx, thread._id);
	await applyAncestorCountChanges(ctx, thread, {
		total: 1,
		active: 0,
		working: 0
	});
}

/** Capture source activity before changing runs or questions, in the same mutation. */
export async function captureThreadActivityBeforeChange(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<ThreadActivity | null> {
	const thread = await ctx.db.get('threadRecords', threadId);

	if (!thread) return null;

	const before = { thread, active: await threadOwnActivity(ctx.db, threadId) };
	const state = await hierarchyState(ctx.db, threadId);

	if (!state) {
		await ensureHierarchyState(ctx, threadId);

		return before;
	}

	// Convert released contribution markers before applying a live transition.
	if (
		state.ownActive !== undefined ||
		state.ownWorking !== undefined ||
		state.ownStatus !== undefined ||
		state.descendantStatusCounts !== undefined ||
		state.workingDescendantCount === undefined
	) {
		await applyAncestorCountChanges(ctx, thread, {
			total: 0,
			active: Number(before.active) - Number(state.ownActive ?? false),
			working:
				Number(thread.status === 'running') -
				Number(state.ownWorking ?? state.ownStatus === 'running')
		});
		await ctx.db.patch('threadHierarchyStates', state._id, {
			workingDescendantCount: workingDescendantCount(state),
			ownActive: undefined,
			ownWorking: undefined,
			ownStatus: undefined,
			descendantStatusCounts: undefined
		});
	}

	return before;
}

/** Apply only the before/after difference; retries observe their already-written source state. */
export async function updateThreadHierarchyAfterChange(
	ctx: MutationCtx,
	before: ThreadActivity | null
): Promise<void> {
	if (!before) return;

	const thread = await ctx.db.get('threadRecords', before.thread._id);

	if (!thread) return;

	await applyAncestorCountChanges(ctx, thread, {
		total: 0,
		active: Number(await threadOwnActivity(ctx.db, thread._id)) - Number(before.active),
		working: Number(thread.status === 'running') - Number(before.thread.status === 'running')
	});
}

export async function migrateThreadHierarchyState(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<void> {
	await captureThreadActivityBeforeChange(ctx, threadId);
}

export async function subtreeSummary(db: DatabaseReader, thread: Doc<'threadRecords'>) {
	const state = await hierarchyState(db, thread._id);
	const descendantsActive = (state?.activeDescendantCount ?? 0) > 0;
	const workingCount = workingDescendantCount(state);

	return {
		descendantCount: state?.descendantCount ?? 0,
		workingDescendantCount: workingCount,
		// Released inbox clients combine all non-running descendants into Completed.
		descendantStatusCounts: {
			queued: 0,
			running: workingCount,
			completed: Math.max(0, (state?.descendantCount ?? 0) - workingCount),
			failed: 0,
			cancelled: 0
		},
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
