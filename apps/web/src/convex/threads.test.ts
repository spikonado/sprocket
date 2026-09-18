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
});
