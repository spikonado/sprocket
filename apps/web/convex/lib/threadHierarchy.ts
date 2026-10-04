import type { Doc, Id } from '@convex/_generated/dataModel';
import type { DatabaseReader, MutationCtx, QueryCtx } from '@convex/_generated/server';
import { paginationOptsValidator } from 'convex/server';
import type { Infer } from 'convex/values';
import { isRunFinalStatus } from '@convex/lib/validators';
import { headActionablePendingQuestion } from '@convex/lib/agentQuestions';

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

/** Ancestor ids from the root down to (and excluding) the given thread. */
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

	const id = await ctx.db.insert('threadHierarchyStates', {
		threadId,
		ownActive: false,
		descendantCount: 0,
		activeDescendantCount: 0,
		registered: false
	});

	return (await ctx.db.get('threadHierarchyStates', id))!;
}

export async function registerChildThread(ctx: MutationCtx, threadId: Id<'threadRecords'>) {
	const thread = await ctx.db.get('threadRecords', threadId);

	if (!thread || thread.parentThreadId === undefined) return;

	const state = await ensureHierarchyState(ctx, threadId);

	if (state.registered) return;

	for (const ancestor of await ancestorThreads(ctx.db, thread)) {
		const parentState = await ensureHierarchyState(ctx, ancestor._id);
		await ctx.db.patch('threadHierarchyStates', parentState._id, {
			descendantCount: parentState.descendantCount + 1
		});
	}

	await ctx.db.patch('threadHierarchyStates', state._id, { registered: true });
}

export async function refreshThreadHierarchyActivity(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>
): Promise<void> {
	const thread = await ctx.db.get('threadRecords', threadId);

	if (!thread) return;

	const state = await ensureHierarchyState(ctx, threadId);
	const active = await threadOwnActivity(ctx.db, threadId);

	if (state.ownActive === active) return;

	const delta = active ? 1 : -1;

	for (const ancestor of await ancestorThreads(ctx.db, thread)) {
		const parentState = await ensureHierarchyState(ctx, ancestor._id);
		const count = parentState.activeDescendantCount + delta;

		if (count < 0) throw new Error('Invalid thread activity aggregate.');

		await ctx.db.patch('threadHierarchyStates', parentState._id, {
			activeDescendantCount: count
		});
	}

	await ctx.db.patch('threadHierarchyStates', state._id, { ownActive: active });

	if (active) await unsettleRootOfThread(ctx, thread);
}

export type SubtreeSummary = {
	descendantCount: number;
	anyActive: boolean;
	descendantsActive: boolean;
};

export async function subtreeSummary(
	db: DatabaseReader,
	thread: Doc<'threadRecords'>
): Promise<SubtreeSummary> {
	const state = await hierarchyState(db, thread._id);
	const descendantsActive = (state?.activeDescendantCount ?? 0) > 0;

	return {
		descendantCount: state?.descendantCount ?? 0,
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

export type ChildPageArgs = Infer<typeof paginationOptsValidator>;

export async function listDirectChildrenPage(
	ctx: QueryCtx | MutationCtx,
	userId: string,
	parentThreadId: Id<'threadRecords'> | undefined,
	paginationOpts: ChildPageArgs
) {
	return await ctx.db
		.query('threadRecords')
		.withIndex('by_userId_and_parentThreadId_and_lastMessageAt', (q) =>
			q.eq('userId', userId).eq('parentThreadId', parentThreadId)
		)
		.order('desc')
		.paginate(paginationOpts);
}
