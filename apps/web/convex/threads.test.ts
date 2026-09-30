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

	it('leaves repository history untouched for retired rekey calls', async () => {
		const t = initConvexTest();
		const { asUser, repositoryKey, subject, threadId } = await seedOwnedThread(t);
		const artifactId = await t.run((ctx) =>
			ctx.db.insert('artifacts', {
				userId: subject,
				scope: 'project',
				repositoryKey,
				registrationId: 'artifact-1',
				content: 'Notes',
				type: 'markdown',
				title: 'Notes',
				revision: 1,
				createdAt: 1,
				updatedAt: 1
			})
		);

		await expect(
			asUser.mutation(api.threads.rekeyRepository, {
				from: repositoryKey,
				to: 'github.com/acme/replacement'
			})
		).resolves.toMatchObject({ from: repositoryKey, to: 'github.com/acme/replacement', count: 0 });

		expect((await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.repositoryKey).toBe(
			repositoryKey
		);
		expect((await t.run((ctx) => ctx.db.get('artifacts', artifactId)))?.repositoryKey).toBe(
			repositoryKey
		);
	});
});
