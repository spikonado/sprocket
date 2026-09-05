import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	type ConvexTestInstance
} from './test.setup';

async function insertSession(
	t: ConvexTestInstance,
	args: {
		threadId: Awaited<ReturnType<typeof seedOwnedThread>>['threadId'];
		userId: string;
		runId: Awaited<ReturnType<typeof createQueuedRun>>['runId'];
		closing?: boolean;
		humanControl?: boolean;
	}
) {
	const startedAt = Date.now();
	await t.run((ctx) =>
		ctx.db.insert('browserSessions', {
			threadId: args.threadId,
			userId: args.userId,
			profileName: 'profile',
			saveChanges: true,
			lastUsedRunId: args.runId,
			startedAt,
			expiresAt: startedAt + 3_600_000,
			sessionId: 'fc-1',
			liveViewUrl: 'https://view.example/firecrawl',
			interactiveLiveViewUrl: 'https://view.example/interactive',
			operationExpiresAt: 0,
			closing: args.closing ?? false,
			humanControl: args.humanControl
		})
	);
	return startedAt;
}

describe('browserSessions', () => {
	it('serves Firecrawl live-view fields to the thread owner only', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_browser_live');
		const { runId } = await createQueuedRun(t, asUser, threadId, 'sub', 'secret', 'Browse');
		const startedAt = await insertSession(t, {
			threadId,
			userId: 'user_browser_live',
			runId,
			humanControl: true
		});

		await expect(
			asUser.query(api.browserSessions.liveViewForThread, { threadId })
		).resolves.toEqual({
			url: 'https://view.example/firecrawl',
			interactiveUrl: 'https://view.example/interactive',
			saving: true,
			humanControl: true,
			threadId,
			expiresAt: startedAt + 3_600_000,
			lastUsedRunId: runId,
			startedAt
		});

		const other = await seedOwnedThread(t, 'user_browser_other');
		await expect(
			other.asUser.query(api.browserSessions.liveViewForThread, { threadId })
		).rejects.toThrow('Thread not found.');
	});

	it('returns null when the session is missing or closing', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_browser_missing');
		const { runId } = await createQueuedRun(t, asUser, threadId, 'sub', 'secret', 'Browse');

		await expect(
			asUser.query(api.browserSessions.liveViewForThread, { threadId })
		).resolves.toBeNull();

		await insertSession(t, {
			threadId,
			userId: 'user_browser_missing',
			runId,
			closing: true
		});
		await expect(
			asUser.query(api.browserSessions.liveViewForThread, { threadId })
		).resolves.toBeNull();
	});
});
