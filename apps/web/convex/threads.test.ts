import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread, seedThreadRecord } from './test.setup';

describe('thread mutations', () => {
	it('lists unsettled, then settled root threads of the run project for agents', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);
		const settled = await seedThreadRecord(t, subject, 'alpha');
		const child = await seedThreadRecord(t, subject, 'alpha');
		await seedThreadRecord(t, subject, 'beta');
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', settled, { archivedAt: 1 });
			await ctx.db.patch('threadRecords', child, { parentThreadId: threadId });
		});
		const executionSecret = 'list-threads-secret';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'list', executionSecret);
		const base = { runId, executionSecret, includeSettled: true };

		const unsettled = await t.query(api.threads.listForRun, base);

		const rest = await t.query(api.threads.listForRun, {
			...base,
			cursor: unsettled.nextCursor ?? undefined
		});

		const children = await t.query(api.threads.listForRun, {
			runId,
			executionSecret,
			parentThreadId: threadId
		});

		expect(unsettled.threads.map((thread) => thread.threadId)).toEqual([threadId]);
		expect(rest).toMatchObject({
			threads: [{ threadId: settled, settled: true }],
			nextCursor: null
		});
		expect(children.threads.map((thread) => thread.threadId)).toEqual([child]);
	});

	it('supports direct mutations', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await expect(
			asUser.mutation(api.threads.rename, { threadId, title: 'Renamed directly' })
		).resolves.toBeNull();
		expect((await asUser.query(api.threads.getByThreadId, { threadId })).title).toBe(
			'Renamed directly'
		);
		await expect(asUser.mutation(api.threads.settle, { threadId })).resolves.toBeNull();
		expect((await asUser.query(api.threads.getByThreadId, { threadId })).archivedAt).toBeDefined();
		await expect(asUser.mutation(api.threads.unsettle, { threadId })).resolves.toBeNull();
		expect(
			(await asUser.query(api.threads.getByThreadId, { threadId })).archivedAt
		).toBeUndefined();
	});

	it('moves a thread tree to another project and resets its cwd', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);

		const grandchildId = await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', threadId, { cwd: '/alpha/sub' });
			await ctx.db.insert('threadHierarchyStates', {
				threadId,
				descendantCount: 2,
				workingDescendantCount: 0,
				activeDescendantCount: 0
			});

			const child = {
				userId: subject,
				status: 'completed',
				repositoryKey: 'alpha',
				cwd: '/alpha/sub',
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				fastMode: false,
				lastMessageAt: Date.now()
			} as const;

			const childId = await ctx.db.insert('threadRecords', { ...child, parentThreadId: threadId });

			return await ctx.db.insert('threadRecords', { ...child, parentThreadId: childId });
		});

		await asUser.mutation(api.threads.moveToProject, { threadId, repositoryKey: 'beta' });

		for (const id of [threadId, grandchildId]) {
			const moved = await t.run(async (ctx) => await ctx.db.get('threadRecords', id));
			expect(moved?.repositoryKey).toBe('beta');
			expect(moved?.cwd).toBeUndefined();
		}
	});
});
