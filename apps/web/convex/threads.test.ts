import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';

describe('thread mutations', () => {
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
