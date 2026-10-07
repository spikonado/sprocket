import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import type { FunctionReturnType } from 'convex/server';
import {
	assertDescendantThreadAccess,
	refreshThreadHierarchyActivity,
	registerChildThread,
	subtreeSummary
} from '@convex/lib/threadHierarchy';
import { initConvexTest, seedOwnedThread } from '@convex/test.setup';
import { setRunAndThreadStatus } from '@convex/lib/threadRunStatus';

type Backend = ReturnType<typeof initConvexTest>;

async function child(
	t: Backend,
	parentId: Id<'threadRecords'>,
	title: string,
	status: Doc<'threadRecords'>['status'] = 'completed'
) {
	return await t.run(async (ctx) => {
		const parent = (await ctx.db.get('threadRecords', parentId))!;

		const threadId = await ctx.db.insert('threadRecords', {
			userId: parent.userId,
			submissionId: title,
			parentThreadId: parentId,
			repositoryKey: parent.repositoryKey,
			status,
			title,
			selectedModel: parent.selectedModel,
			reasoningEffort: parent.reasoningEffort,
			fastMode: parent.fastMode,
			lastMessageAt: parent.lastMessageAt
		});

		await registerChildThread(ctx, (await ctx.db.get('threadRecords', threadId))!);

		return threadId;
	});
}

async function summary(t: Backend, threadId: Id<'threadRecords'>) {
	return await t.run(async (ctx) => {
		return await subtreeSummary(ctx.db, (await ctx.db.get('threadRecords', threadId))!);
	});
}

describe('thread hierarchy', () => {
	it('maintains complete wide-tree counts and any-depth activity without changing root ordering', async () => {
		const t = initConvexTest();
		const { threadId, asUser, repositoryKey } = await seedOwnedThread(t);
		const children = [];

		for (let i = 0; i < 70; i += 1) children.push(await child(t, threadId, `child-${i}`));
		const grandchild = await child(t, children[0], 'grandchild');
		expect(await summary(t, threadId)).toEqual({
			descendantCount: 71,
			workingDescendantCount: 0,
			descendantStatusCounts: { queued: 0, running: 0, completed: 71, failed: 0, cancelled: 0 },
			anyActive: false,
			descendantsActive: false
		});

		const before = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		await asUser.mutation(api.threads.settle, { threadId });
		await t.run(async (ctx) => {
			await ctx.db.insert('runs', {
				threadId: grandchild,
				userId: 'user_alice',
				submissionId: 'grandchild-start',
				status: 'queued',
				executionSecretHash: 'test-secret',
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'high',
				fastMode: false,
				startedAt: Date.now()
			});
			await refreshThreadHierarchyActivity(ctx, grandchild);
			await refreshThreadHierarchyActivity(ctx, grandchild);
		});

		expect(await summary(t, threadId)).toEqual({
			descendantCount: 71,
			workingDescendantCount: 0,
			descendantStatusCounts: { queued: 0, running: 0, completed: 71, failed: 0, cancelled: 0 },
			anyActive: true,
			descendantsActive: true
		});
		expect(await summary(t, children[0])).toEqual({
			descendantCount: 1,
			workingDescendantCount: 0,
			descendantStatusCounts: { queued: 0, running: 0, completed: 1, failed: 0, cancelled: 0 },
			anyActive: true,
			descendantsActive: true
		});
		const after = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(after?.archivedAt).toBeUndefined();
		expect(after?.lastMessageAt).toBe(before?.lastMessageAt);
		await expect(asUser.mutation(api.threads.settle, { threadId })).rejects.toThrow(/active work/);

		const inbox = await asUser.query(api.inbox.list, {
			state: 'unsettled',
			repositoryKeys: [repositoryKey],
			paginationOpts: { cursor: null, numItems: 10 }
		});

		expect(inbox.page.map((thread) => thread._id)).toEqual([threadId]);
	});

	it('allows strict same-user descendant access and rejects self, sibling, ancestor, and foreign targets', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		const first = await child(t, threadId, 'first');
		const sibling = await child(t, threadId, 'sibling');
		const grandchild = await child(t, first, 'grandchild');
		const foreign = await seedOwnedThread(t, 'user_bob');

		const access = (caller: Id<'threadRecords'>, target: Id<'threadRecords'>) =>
			t.run((ctx) =>
				assertDescendantThreadAccess(ctx.db, { threadId: caller, userId: 'user_alice' }, target)
			);

		expect((await access(threadId, grandchild))._id).toBe(grandchild);
		expect((await access(first, grandchild))._id).toBe(grandchild);

		for (const target of [first, sibling, threadId, foreign.threadId]) {
			await expect(access(first, target)).rejects.toThrow('Thread not found.');
		}
	});

	it('paginates direct children with equal activity independently of total-descendant counts', async () => {
		const t = initConvexTest();
		const { threadId, asUser } = await seedOwnedThread(t);
		const children = [];

		for (let i = 0; i < 7; i += 1) children.push(await child(t, threadId, `child-${i}`));
		await child(t, children[0], 'nested');
		const seen = [];
		let cursor: string | null = null;

		for (;;) {
			const page: FunctionReturnType<typeof api.threads.listChildren> = await asUser.query(
				api.threads.listChildren,
				{
					threadId,
					paginationOpts: { cursor, numItems: 2 }
				}
			);

			seen.push(...page.page.map((thread) => thread._id));

			if (page.isDone) break;
			cursor = page.continueCursor;
		}

		expect(seen).toHaveLength(7);
		expect(new Set(seen)).toEqual(new Set(children));
		expect(await summary(t, threadId)).toEqual({
			descendantCount: 8,
			workingDescendantCount: 0,
			descendantStatusCounts: { queued: 0, running: 0, completed: 8, failed: 0, cancelled: 0 },
			anyActive: false,
			descendantsActive: false
		});
		await expect(asUser.mutation(api.threads.settle, { threadId: children[0] })).rejects.toThrow(
			/root/
		);
		await expect(asUser.mutation(api.threads.unsettle, { threadId: children[0] })).rejects.toThrow(
			/root/
		);
	});

	it('distinguishes parent work from descendant work in expansion badges', async () => {
		const t = initConvexTest();
		const { threadId, asUser } = await seedOwnedThread(t);
		await child(t, threadId, 'idle-child');
		await t.run(async (ctx) => {
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
				.first();

			await ctx.db.patch('runs', run!._id, { status: 'running' });
			await refreshThreadHierarchyActivity(ctx, threadId);
		});
		expect(await asUser.query(api.threads.subtreeSummaryForThread, { threadId })).toEqual({
			descendantCount: 1,
			workingDescendantCount: 0,
			descendantStatusCounts: { queued: 0, running: 0, completed: 1, failed: 0, cancelled: 0 },
			anyActive: true,
			descendantsActive: false
		});
	});

	it('counts only running descendants at every depth and propagates active-to-active transitions idempotently', async () => {
		const t = initConvexTest();
		const { threadId, asUser } = await seedOwnedThread(t);
		const queued = await child(t, threadId, 'queued', 'queued');
		await child(t, threadId, 'completed');
		await child(t, threadId, 'failed', 'failed');
		await child(t, threadId, 'cancelled', 'cancelled');
		const running = await child(t, queued, 'running', 'running');

		const runIds = await t.run(async (ctx) => {
			const ids = [];

			for (const id of [queued, running]) {
				const thread = (await ctx.db.get('threadRecords', id))!;
				ids.push(
					await ctx.db.insert('runs', {
						threadId: id,
						userId: thread.userId,
						submissionId: thread.submissionId,
						status: thread.status,
						executionSecretHash: 'fixture',
						selectedModel: thread.selectedModel,
						reasoningEffort: thread.reasoningEffort,
						fastMode: thread.fastMode,
						startedAt: Date.now()
					})
				);
				await refreshThreadHierarchyActivity(ctx, id);
			}

			await ctx.db.patch('threadRecords', threadId, { status: 'failed' });
			await refreshThreadHierarchyActivity(ctx, threadId);

			return ids;
		});

		expect(await asUser.query(api.threads.subtreeSummaryForThread, { threadId })).toEqual({
			descendantCount: 5,
			workingDescendantCount: 1,
			descendantStatusCounts: { queued: 0, running: 1, completed: 4, failed: 0, cancelled: 0 },
			anyActive: true,
			descendantsActive: true
		});
		expect((await summary(t, queued)).workingDescendantCount).toBe(1);
		expect((await summary(t, running)).workingDescendantCount).toBe(0);

		const transition = (runId: Id<'runs'>, status: Doc<'runs'>['status']) =>
			t.run(async (ctx) => {
				await setRunAndThreadStatus(ctx, (await ctx.db.get('runs', runId))!, status);
			});

		await transition(runIds[0], 'running');
		expect((await summary(t, threadId)).workingDescendantCount).toBe(2);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query('threadHierarchyStates')
					.withIndex('by_threadId', (q) => q.eq('threadId', threadId))
					.unique()
			)
		).toMatchObject({ activeDescendantCount: 2 });

		await transition(runIds[1], 'failed');
		expect((await summary(t, threadId)).workingDescendantCount).toBe(1);
		expect(await summary(t, queued)).toMatchObject({
			descendantCount: 1,
			workingDescendantCount: 0,
			descendantStatusCounts: { queued: 0, running: 0, completed: 1, failed: 0, cancelled: 0 },
			anyActive: true,
			descendantsActive: false
		});

		await transition(runIds[0], 'cancelled');
		expect(await summary(t, threadId)).toEqual({
			descendantCount: 5,
			workingDescendantCount: 0,
			descendantStatusCounts: { queued: 0, running: 0, completed: 5, failed: 0, cancelled: 0 },
			anyActive: false,
			descendantsActive: false
		});

		const beforeTerminalTransition = await t.run((ctx) =>
			ctx.db.query('threadHierarchyStates').collect()
		);

		await transition(runIds[1], 'completed');
		expect((await summary(t, threadId)).workingDescendantCount).toBe(0);
		expect((await summary(t, queued)).workingDescendantCount).toBe(0);
		expect(await t.run((ctx) => ctx.db.query('threadHierarchyStates').collect())).toEqual(
			beforeTerminalTransition
		);

		const states = await t.run((ctx) => ctx.db.query('threadHierarchyStates').collect());
		await t.run(async (ctx) => {
			for (const id of [threadId, queued, running]) {
				await refreshThreadHierarchyActivity(ctx, id);
				await refreshThreadHierarchyActivity(ctx, id);
			}
		});
		expect(await t.run((ctx) => ctx.db.query('threadHierarchyStates').collect())).toEqual(states);
	});
});
