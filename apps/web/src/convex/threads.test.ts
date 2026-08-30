import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

describe('threads.listMine ordering', () => {
	it('puts threads with an active run first, then by lastMessageAt', async () => {
		const t = initConvexTest();
		const { asUser, repositoryKey, threadId: seeded } = await seedOwnedThread(t);

		const makeThread = async (submissionId: string) =>
			(
				await asUser.mutation(api.threads.create, {
					submissionId,
					repositoryKey,
					selectedModel: 'gpt-5.6-sol',
					reasoningEffort: 'medium',
					serviceTier: 'standard'
				})
			).threadId;

		// Two extra idle threads, then a queued (active) run on the seeded thread.
		// The seeded thread is the oldest by creation, so it would normally sort
		// last among same-activity threads; the active run must promote it.
		await makeThread('thread-idle-a');
		await makeThread('thread-idle-b');
		await createQueuedRun(t, asUser, seeded, 'thread-running-run', 'sort-secret');

		const threads = await asUser.query(api.threads.listMine, {});
		expect(threads[0]?.threadId).toBe(seeded);
		expect(threads[0]?.hasActiveRun).toBe(true);
		// The remaining threads are idle and ordered by lastMessageAt, newest first.
		const idleLastMessageAts = threads.slice(1).map((thread) => thread.lastMessageAt);
		expect([...idleLastMessageAts].sort((a, b) => b - a)).toEqual(idleLastMessageAts);
	});

	it('keeps multiple running threads in lastMessageAt order among themselves', async () => {
		const t = initConvexTest();
		const { asUser, repositoryKey } = await seedOwnedThread(t);

		const makeThread = async (submissionId: string) =>
			(
				await asUser.mutation(api.threads.create, {
					submissionId,
					repositoryKey,
					selectedModel: 'gpt-5.6-sol',
					reasoningEffort: 'medium',
					serviceTier: 'standard'
				})
			).threadId;

		// Two running threads created back to back; the newer one has the higher
		// lastMessageAt and must lead the pinned group.
		const runningOlder = await makeThread('thread-running-older');
		const runningNewer = await makeThread('thread-running-newer');
		await makeThread('thread-idle');
		await createQueuedRun(t, asUser, runningOlder, 'run-older', 'sort-secret');
		await createQueuedRun(t, asUser, runningNewer, 'run-newer', 'sort-secret');

		const threads = await asUser.query(api.threads.listMine, {});
		const runningIds = threads.filter((thread) => thread.hasActiveRun).map((t) => t.threadId);
		expect(runningIds).toEqual([runningNewer, runningOlder]);
	});
});

describe('threads.rekeyRepository', () => {
	it('rewrites this user’s threads from the old key to the new one', async () => {
		const t = initConvexTest();
		const { asUser, repositoryKey, threadId } = await seedOwnedThread(t);
		const other = await asUser.mutation(api.threads.create, {
			submissionId: 'other-repo',
			repositoryKey: 'beta',
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard'
		});

		expect(
			await asUser.mutation(api.threads.rekeyRepository, { from: repositoryKey, to: 'gamma' })
		).toBe(1);

		const threads = await asUser.query(api.threads.listMine, {});
		expect(threads.find((thread) => thread.threadId === threadId)?.repositoryKey).toBe('gamma');
		expect(threads.find((thread) => thread.threadId === other.threadId)?.repositoryKey).toBe(
			'beta'
		);
	});
});

describe('threads owner-key dual-read', () => {
	it('lists and reuses a pre-migration subject-keyed thread', async () => {
		const t = initConvexTest();
		const { asUser, threadId, repositoryKey } = await seedOwnedThread(t, 'user_legacy_thread');
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', threadId, { userId: 'user_legacy_thread' });
		});

		const listed = await asUser.query(api.threads.listMine, {});
		const seeded = listed.find((thread) => thread.threadId === threadId);
		expect(seeded).toBeDefined();

		const created = await asUser.mutation(api.threads.create, {
			submissionId: seeded?.submissionId ?? '',
			repositoryKey,
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard'
		});
		expect(created.threadId).toBe(threadId);
	});
});
