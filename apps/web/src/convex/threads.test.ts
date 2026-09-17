import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';

describe('thread mutations', () => {
	it('supports direct mutations and released-server aliases', async () => {
		const t = initConvexTest();
		const { asUser, subject, repositoryKey, threadId } = await seedOwnedThread(t);
		await expect(
			asUser.mutation(api.threads.rename, { threadId, title: 'Renamed directly' })
		).resolves.toBeNull();
		await expect(asUser.mutation(api.threads.settle, { threadId })).resolves.toBeNull();
		await expect(asUser.mutation(api.threads.unsettle, { threadId })).resolves.toBeNull();
		expect(
			await asUser.mutation(api.threads.renameForLocalCache, { threadId, title: 'Renamed locally' })
		).toEqual({ userId: subject, repositoryKey });
		expect(await asUser.mutation(api.threads.archiveForLocalCache, { threadId })).toEqual({
			userId: subject,
			repositoryKey
		});
		expect(await asUser.mutation(api.threads.restoreForLocalCache, { threadId })).toEqual({
			userId: subject,
			repositoryKey
		});
	});
});
