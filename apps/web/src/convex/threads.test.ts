import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

describe('threads.listMine ordering', () => {
	it('puts threads with an active run first, then by lastMessageAt', async () => {
		const t = initConvexTest();
		const { asUser, projectId, threadId: seeded } = await seedOwnedThread(t);

		const makeThread = async (submissionId: string) =>
			(
				await asUser.mutation(api.threads.create, {
					submissionId,
					projectId,
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
		await createQueuedRun(asUser, seeded, 'thread-running-run', 'sort-secret');

		const threads = await asUser.query(api.threads.listMine, {});
		expect(threads[0]?.threadId).toBe(seeded);
		expect(threads[0]?.hasActiveRun).toBe(true);
		// The remaining threads are idle and ordered by lastMessageAt, newest first.
		const idleLastMessageAts = threads.slice(1).map((thread) => thread.lastMessageAt);
		expect([...idleLastMessageAts].sort((a, b) => b - a)).toEqual(idleLastMessageAts);
	});
});
