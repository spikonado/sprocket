import { afterEach, describe, expect, it, vi } from 'vitest';
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
	const id = await t.run((ctx) =>
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
	return { id, startedAt };
}

describe('browserSessions', () => {
	it('only lets the session owner stop it and leaves the run untouched', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'browser-owner');
		const other = await seedOwnedThread(t, 'browser-stranger');
		const { runId } = await createQueuedRun(t, asUser, threadId, 'sub', 'secret', 'Browse');
		const { id } = await insertSession(t, { threadId, userId: 'browser-owner', runId });
		const run = await t.run((ctx) => ctx.db.get('runs', runId));
		await expect(
			other.asUser.mutation(api.browserSessions.stop, { id, providerSessionId: 'fc-1' })
		).rejects.toThrow('Thread not found.');
		expect((await t.run((ctx) => ctx.db.get('browserSessions', id)))?.closing).toBe(false);
		await asUser.mutation(api.browserSessions.stop, { id, providerSessionId: 'fc-1' });
		await asUser.mutation(api.browserSessions.stop, { id, providerSessionId: 'fc-1' });
		expect(await t.run((ctx) => ctx.db.get('browserSessions', id))).toBeNull();
		expect(await asUser.query(api.browserSessions.liveViewForThread, { threadId })).toBeNull();
		expect(await t.run((ctx) => ctx.db.get('runs', runId))).toEqual(run);
	});

	it('schedules a remote close for sessions created before the provider shutdown', async () => {
		vi.useFakeTimers();
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'browser-legacy');
		const { runId } = await createQueuedRun(t, asUser, threadId, 'sub', 'secret', 'Browse');
		const { id } = await insertSession(t, { threadId, userId: 'browser-legacy', runId });
		vi.stubEnv('FIRECRAWL_BROWSER_API_KEY', 'legacy-key');
		const fetch = vi.fn(async () => new Response('{"success":true}'));
		vi.stubGlobal('fetch', fetch);
		await asUser.mutation(api.browserSessions.stop, { id, providerSessionId: 'fc-1' });
		await vi.advanceTimersByTimeAsync(1_000);
		await t.finishInProgressScheduledFunctions();
		expect(fetch).toHaveBeenCalledWith(
			'https://api.firecrawl.dev/v2/interact/fc-1',
			expect.objectContaining({ method: 'DELETE' })
		);
	});

	it('retries the remote close until the provider confirms or the session is gone', async () => {
		vi.useFakeTimers();
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'browser-retry');
		const { runId } = await createQueuedRun(t, asUser, threadId, 'sub', 'secret', 'Browse');
		const { id } = await insertSession(t, { threadId, userId: 'browser-retry', runId });
		vi.stubEnv('FIRECRAWL_BROWSER_API_KEY', 'legacy-key');
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockRejectedValueOnce(new Error('network down'))
			.mockResolvedValueOnce(new Response('{"success":false}', { status: 500 }))
			.mockResolvedValueOnce(new Response('{"success":true}', { status: 404 }))
			.mockResolvedValue(new Response('{"success":true}'));
		vi.stubGlobal('fetch', fetch);
		await asUser.mutation(api.browserSessions.stop, { id, providerSessionId: 'fc-1' });
		for (let attempt = 0; attempt < 4; attempt++) {
			await vi.advanceTimersByTimeAsync(30_000 * 2 ** attempt + 1_000);
			await t.finishInProgressScheduledFunctions();
		}
		// Two failures retried with backoff; the 404 ends the retries.
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it('serves live-view fields to the thread owner only', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_browser_live');
		const { runId } = await createQueuedRun(t, asUser, threadId, 'sub', 'secret', 'Browse');
		const { id, startedAt } = await insertSession(t, {
			threadId,
			userId: 'user_browser_live',
			runId,
			humanControl: true
		});

		await expect(
			asUser.query(api.browserSessions.liveViewForThread, { threadId })
		).resolves.toEqual({
			id,
			providerSessionId: 'fc-1',
			url: 'https://view.example/firecrawl',
			interactiveUrl: 'https://view.example/interactive',
			saving: true,
			humanControl: true,
			ended: false,
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

	it('distinguishes missing sessions from ended sessions without exposing ended URLs', async () => {
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
		).resolves.toMatchObject({ ended: true, url: null, interactiveUrl: null, lastUsedRunId: null });
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});
