import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import type { FunctionReturnType } from 'convex/server';
import {
	assertDescendantThreadAccess,
	refreshThreadHierarchyActivity,
	registerChildThread,
	subtreeSummary
} from '@convex/lib/threadHierarchy';
import { initConvexTest, seedOwnedThread } from '@convex/test.setup';

type Backend = ReturnType<typeof initConvexTest>;

async function child(t: Backend, parentId: Id<'threadRecords'>, title: string) {
	return await t.run(async (ctx) => {
		const parent = (await ctx.db.get('threadRecords', parentId))!;

		const threadId = await ctx.db.insert('threadRecords', {
			userId: parent.userId,
			submissionId: title,
			parentThreadId: parentId,
			repositoryKey: parent.repositoryKey,
			status: 'completed',
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
			anyActive: true,
			descendantsActive: true
		});
		expect(await summary(t, children[0])).toEqual({
			descendantCount: 1,
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
			anyActive: true,
			descendantsActive: false
		});
	});
});
