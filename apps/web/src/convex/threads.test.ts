import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { initConvexTest, seedOwnedThread, seedThreadRecord } from './test.setup';

describe('threads local-cache commands', () => {
	it('stores the selected model on its thread', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await asUser.mutation(api.threads.setSelectedModel, { threadId, selectedModel: 'grok-4.5' });
		expect((await asUser.query(api.threads.getByThreadId, { threadId })).selectedModel).toBe(
			'grok-4.5'
		);
	});

	it('returns authenticated command metadata', async () => {
		const t = initConvexTest();
		const { asUser, subject, repositoryKey, threadId } = await seedOwnedThread(t);
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

describe('threads.listRecent', () => {
	it('returns the latest 15 records for only the authenticated user', async () => {
		const t = initConvexTest();
		const { asUser, subject } = await seedOwnedThread(t, 'user_alice');
		const ids: Id<'threadRecords'>[] = [];
		for (let index = 0; index < 16; index += 1) {
			const id = await seedThreadRecord(t, subject, `repo-${index}`);
			await t.run(async (ctx) =>
				ctx.db.patch('threadRecords', id, {
					lastMessageAt: index,
					archivedAt: index === 15 ? 1 : undefined
				})
			);
			ids.push(id);
		}
		const bob = await seedOwnedThread(t, 'user_bob');

		const records = await asUser.query(api.threads.listRecent, {});

		expect(records).toHaveLength(15);
		expect(records.map((record) => record.lastMessageAt)).toEqual(
			records.map((record) => record.lastMessageAt).sort((a, b) => b - a)
		);
		expect(records.some((record) => record._id === ids[0])).toBe(false);
		expect(records.find((record) => record._id === ids[15])?.archivedAt).toBe(1);
		expect(records.some((record) => record._id === bob.threadId)).toBe(false);

		const recordsWithOlderSelection = await asUser.query(api.threads.listRecent, {
			selectedThreadId: ids[0]
		});
		expect(recordsWithOlderSelection).toHaveLength(16);
		expect(recordsWithOlderSelection.at(-1)?._id).toBe(ids[0]);

		const recordsWithForeignSelection = await asUser.query(api.threads.listRecent, {
			selectedThreadId: bob.threadId
		});
		expect(recordsWithForeignSelection).toEqual(records);
	});
});
