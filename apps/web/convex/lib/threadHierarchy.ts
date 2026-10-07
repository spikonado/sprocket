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
		ownActive: false,
		ownWorking: false,
		descendantCount: 0,
		activeDescendantCount: 0,
		workingDescendantCount: 0
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
	const working = thread.status === 'running';

	const workingDelta = Number(working) - Number(state.ownWorking ?? state.ownStatus === 'running');

	const needsMigration =
		state.ownWorking === undefined ||
		state.workingDescendantCount === undefined ||
		state.ownStatus !== undefined ||
		state.descendantStatusCounts !== undefined;

	if (activityDelta === 0 && workingDelta === 0 && !needsMigration) return;

	if (activityDelta !== 0 || workingDelta !== 0) {
		for (const ancestor of await ancestorThreads(ctx.db, thread)) {
			const parentState = await ensureHierarchyState(ctx, ancestor._id);
			const activeCount = parentState.activeDescendantCount + activityDelta;
			const workingCount = workingDescendantCount(parentState) + workingDelta;

			if (activeCount < 0 || workingCount < 0) {
				throw new Error('Invalid thread activity aggregate.');
			}

			await ctx.db.patch('threadHierarchyStates', parentState._id, {
				activeDescendantCount: activeCount,
				workingDescendantCount: workingCount,
				descendantStatusCounts: undefined
			});
		}
	}

	await ctx.db.patch('threadHierarchyStates', state._id, {
		ownActive: active,
		ownWorking: working,
		workingDescendantCount: workingDescendantCount(state),
		ownStatus: undefined,
		descendantStatusCounts: undefined
	});

	if (activityDelta > 0) await unsettleRootOfThread(ctx, thread);
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
