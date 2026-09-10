import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
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

afterEach(() => vi.useRealTimers());

describe('browserSessions', () => {
	it('only lets the session owner stop it and leaves the run untouched', async () => {
		vi.useFakeTimers();
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'browser-owner');
		const other = await seedOwnedThread(t, 'browser-stranger');
		const { runId } = await createQueuedRun(t, asUser, threadId, 'sub', 'secret', 'Browse');
		const { id } = await insertSession(t, { threadId, userId: 'browser-owner', runId });
		const run = await t.run((ctx) => ctx.db.get('runs', runId));
		await expect(other.asUser.mutation(api.browserSessions.stop, { id })).rejects.toThrow(
			'Thread not found.'
		);
		expect((await t.run((ctx) => ctx.db.get('browserSessions', id)))?.closing).toBe(false);
		await asUser.mutation(api.browserSessions.stop, { id });
		await asUser.mutation(api.browserSessions.stop, { id });
		expect(await asUser.query(api.browserSessions.liveViewForThread, { threadId })).toMatchObject({
			id,
			ended: true,
			url: null,
			interactiveUrl: null
		});
		expect(await t.run((ctx) => ctx.db.get('runs', runId))).toEqual(run);
	});

	it('serves Firecrawl live-view fields to the thread owner only', async () => {
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

	it('publishes the ended state when the backend hard-expiry mutation runs', async () => {
		vi.useFakeTimers();
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_browser_expiry');
		const { runId } = await createQueuedRun(t, asUser, threadId, 'sub', 'secret', 'Browse');
		const { id, startedAt } = await insertSession(t, {
			threadId,
			userId: 'user_browser_expiry',
			runId
		});
		await t.mutation(internal.browserSessions.expire, { id });
		await expect(
			asUser.query(api.browserSessions.liveViewForThread, { threadId })
		).resolves.toMatchObject({ ended: false });
		vi.setSystemTime(startedAt + 3_600_000);
		await t.mutation(internal.browserSessions.expire, { id });
		await expect(
			asUser.query(api.browserSessions.liveViewForThread, { threadId })
		).resolves.toMatchObject({ ended: true, url: null, interactiveUrl: null, lastUsedRunId: null });
	});
});
