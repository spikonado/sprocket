import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';

describe('threads local-cache commands', () => {
	it('stores the selected model on its thread and advances the cache revision', async () => {
		const t = initConvexTest();
		const { asUser, repositoryKey, threadId } = await seedOwnedThread(t);

		await asUser.mutation(api.threads.setSelectedModel, {
			threadId,
			selectedModel: 'grok-4.5'
		});

		expect((await asUser.query(api.threads.getByThreadId, { threadId })).selectedModel).toBe(
			'grok-4.5'
		);
		expect(
			await asUser.query(api.threads.getSnapshotRevision, {
				repositoryKey,
				category: 'active'
			})
		).toBe(2);
	});

	it('returns authenticated cache-refresh metadata', async () => {
		const t = initConvexTest();
		const { asUser, subject, repositoryKey, threadId } = await seedOwnedThread(t);

		expect(
			await asUser.mutation(api.threads.renameForLocalCache, {
				threadId,
				title: 'Renamed locally'
			})
		).toEqual({ userId: subject, repositoryKey, category: 'active' });
		expect(await asUser.mutation(api.threads.archiveForLocalCache, { threadId })).toEqual({
			userId: subject,
			repositoryKey
		});
		expect(
			await asUser.mutation(api.threads.renameForLocalCache, {
				threadId,
				title: 'Renamed while archived'
			})
		).toEqual({ userId: subject, repositoryKey, category: 'archived' });
		expect(await asUser.mutation(api.threads.restoreForLocalCache, { threadId })).toEqual({
			userId: subject,
			repositoryKey
		});
		const other = await asUser.mutation(api.threads.create, {
			submissionId: 'other-repo',
			repositoryKey: 'beta',
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard'
		});
		expect(
			await asUser.mutation(api.threads.rekeyRepositoryForLocalCache, {
				from: ` ${repositoryKey} `,
				to: ' gamma '
			})
		).toEqual({ userId: subject, from: repositoryKey, to: 'gamma', count: 1 });
		expect((await asUser.query(api.threads.getByThreadId, { threadId })).repositoryKey).toBe(
			'gamma'
		);
		expect(
			(await asUser.query(api.threads.getByThreadId, { threadId: other.threadId })).repositoryKey
		).toBe('beta');
	});
});

describe('threads snapshot pages and revisions', () => {
	it('pages active threads for one repository and leaves archived to the other category', async () => {
		const t = initConvexTest();
		const { asUser, repositoryKey, threadId } = await seedOwnedThread(t);
		const otherRepo = await asUser.mutation(api.threads.create, {
			submissionId: 'other-repo-thread',
			repositoryKey: 'beta',
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard'
		});
		const archived = await asUser.mutation(api.threads.create, {
			submissionId: 'archived-thread',
			repositoryKey,
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard'
		});
		await asUser.mutation(api.threads.archiveForLocalCache, { threadId: archived.threadId });

		const active = await asUser.query(api.threads.listSnapshotPage, {
			repositoryKey,
			category: 'active',
			paginationOpts: { numItems: 32, cursor: null }
		});
		expect(active.page.map((thread) => thread.threadId)).toEqual([threadId]);
		expect(active.isDone).toBe(true);

		const archivedPage = await asUser.query(api.threads.listSnapshotPage, {
			repositoryKey,
			category: 'archived',
			paginationOpts: { numItems: 32, cursor: null }
		});
		expect(archivedPage.page.map((thread) => thread.threadId)).toEqual([archived.threadId]);
		expect(
			(
				await asUser.query(api.threads.listSnapshotPage, {
					repositoryKey: 'beta',
					category: 'active',
					paginationOpts: { numItems: 32, cursor: null }
				})
			).page.map((thread) => thread.threadId)
		).toEqual([otherRepo.threadId]);
	});

	it('bumps revisions in the same transaction as create, archive, restore, and rekey', async () => {
		const t = initConvexTest();
		const { asUser, repositoryKey } = await seedOwnedThread(t);
		expect(
			await asUser.query(api.threads.getSnapshotRevision, {
				repositoryKey,
				category: 'active'
			})
		).toBe(1);

		const created = await asUser.mutation(api.threads.create, {
			submissionId: 'revision-archive',
			repositoryKey,
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard'
		});
		expect(
			await asUser.query(api.threads.getSnapshotRevision, {
				repositoryKey,
				category: 'active'
			})
		).toBe(2);

		await asUser.mutation(api.threads.archiveForLocalCache, { threadId: created.threadId });
		expect(
			await asUser.query(api.threads.getSnapshotRevision, {
				repositoryKey,
				category: 'active'
			})
		).toBe(3);
		expect(
			await asUser.query(api.threads.getSnapshotRevision, {
				repositoryKey,
				category: 'archived'
			})
		).toBe(1);

		await asUser.mutation(api.threads.restoreForLocalCache, { threadId: created.threadId });
		expect(
			await asUser.query(api.threads.getSnapshotRevision, {
				repositoryKey,
				category: 'archived'
			})
		).toBe(2);
		expect(
			await asUser.query(api.threads.getSnapshotRevision, {
				repositoryKey,
				category: 'active'
			})
		).toBe(4);

		await asUser.mutation(api.threads.rekeyRepositoryForLocalCache, {
			from: repositoryKey,
			to: 'gamma'
		});
		expect(
			await asUser.query(api.threads.getSnapshotRevision, {
				repositoryKey,
				category: 'active'
			})
		).toBe(5);
		expect(
			await asUser.query(api.threads.getSnapshotRevision, {
				repositoryKey: 'gamma',
				category: 'active'
			})
		).toBe(1);
	});

	it('does not leak another user’s repository snapshot', async () => {
		const t = initConvexTest();
		const alice = await seedOwnedThread(t, 'user_alice');
		const bob = await seedOwnedThread(t, 'user_bob');
		const alicePage = await alice.asUser.query(api.threads.listSnapshotPage, {
			repositoryKey: alice.repositoryKey,
			category: 'active',
			paginationOpts: { numItems: 32, cursor: null }
		});
		expect(alicePage.page.map((thread) => thread.threadId)).toEqual([alice.threadId]);
		expect(alicePage.page.some((thread) => thread.threadId === bob.threadId)).toBe(false);
	});
});
