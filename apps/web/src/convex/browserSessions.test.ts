import { describe, expect, it } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	type ConvexTestInstance
} from './test.setup';

async function seedRun(t: ConvexTestInstance, subject: string) {
	const { asUser, threadId } = await seedOwnedThread(t, subject);
	const created = await createQueuedRun(
		t,
		asUser,
		threadId,
		`sub-${Math.random()}`,
		`secret-${Math.random()}`,
		'Browse'
	);
	return { asUser, threadId, runId: created.runId, userId: subject };
}

describe('browserSessions', () => {
	it('selects the most recently used provider and falls back when Firecrawl closes', async () => {
		const t = initConvexTest();
		const { asUser, threadId, runId, userId } = await seedRun(t, 'user_browser_mixed');
		await t.mutation(internal.browserSessions.upsertForThread, {
			threadId,
			runId,
			userId,
			browserbaseSessionId: 'legacy',
			liveViewUrl: 'https://view.example/legacy'
		});
		await t.run((ctx) => ctx.db.patch('runs', runId, { status: 'completed' }));
		await new Promise((resolve) => setTimeout(resolve, 5));
		const newer = await createQueuedRun(t, asUser, threadId, 'newer', 'secret');
		const firecrawlId = await t.run(async (ctx) => {
			return await ctx.db.insert('firecrawlSessions', {
				threadId,
				userId,
				lastUsedRunId: newer.runId,
				profileName: 'profile',
				saveChanges: true,
				startedAt: Date.now(),
				expiresAt: Date.now() + 3_600_000,
				operationExpiresAt: 0,
				closing: false,
				liveViewUrl: 'https://view.example/firecrawl'
			});
		});
		expect((await asUser.query(api.browserSessions.liveViewForThread, { threadId }))?.url).toBe(
			'https://view.example/firecrawl'
		);
		await t.run((ctx) => ctx.db.patch('firecrawlSessions', firecrawlId, { closing: true }));
		expect((await asUser.query(api.browserSessions.liveViewForThread, { threadId }))?.url).toBe(
			'https://view.example/legacy'
		);
		await t.run((ctx) =>
			ctx.db.patch('firecrawlSessions', firecrawlId, { closing: false, lastUsedRunId: runId })
		);
		await t.mutation(internal.browserSessions.touchForThread, { threadId, runId: newer.runId });
		expect((await asUser.query(api.browserSessions.liveViewForThread, { threadId }))?.url).toBe(
			'https://view.example/legacy'
		);
	});

	it('creates a session row and returns it for the owning user', async () => {
		const t = initConvexTest();
		const { threadId, runId, userId } = await seedRun(t, 'user_browser_a');

		const id = await t.mutation(internal.browserSessions.upsertForThread, {
			threadId,
			runId,
			userId,
			browserbaseSessionId: 'bb-1'
		});

		const session = await t.query(internal.browserSessions.getForThread, { threadId, userId });
		expect(session).toMatchObject({
			_id: id,
			threadId,
			runId,
			userId,
			browserbaseSessionId: 'bb-1'
		});
	});

	it('replaces the session on re-upsert, keeping one row per thread', async () => {
		const t = initConvexTest();
		const { threadId, runId, userId } = await seedRun(t, 'user_browser_b');

		const firstId = await t.mutation(internal.browserSessions.upsertForThread, {
			threadId,
			runId,
			userId,
			browserbaseSessionId: 'bb-old'
		});
		const first = await t.query(internal.browserSessions.getForThread, { threadId, userId });
		await new Promise((resolve) => setTimeout(resolve, 5));

		const secondId = await t.mutation(internal.browserSessions.upsertForThread, {
			threadId,
			runId,
			userId,
			browserbaseSessionId: 'bb-new'
		});

		expect(secondId).toBe(firstId);
		const session = await t.query(internal.browserSessions.getForThread, { threadId, userId });
		expect(session?.browserbaseSessionId).toBe('bb-new');
		expect(session?.startedAt).toBeGreaterThan(first?.startedAt ?? 0);

		const rows = await t.run(async (ctx) => await ctx.db.query('browserSessions').collect());
		expect(rows.filter((row) => row.threadId === threadId)).toHaveLength(1);
	});

	it('hides the session from other users and other threads', async () => {
		const t = initConvexTest();
		const { threadId, runId, userId } = await seedRun(t, 'user_browser_c');
		await t.mutation(internal.browserSessions.upsertForThread, {
			threadId,
			runId,
			userId,
			browserbaseSessionId: 'bb-1'
		});

		const other = await seedRun(t, 'user_browser_d');
		await expect(
			t.query(internal.browserSessions.getForThread, { threadId, userId: other.userId })
		).resolves.toBeNull();
		await expect(
			t.query(internal.browserSessions.getForThread, {
				threadId: other.threadId,
				userId: other.userId
			})
		).resolves.toBeNull();
	});

	it('serves the live view state to the thread owner only', async () => {
		const t = initConvexTest();
		const { asUser, threadId, runId, userId } = await seedRun(t, 'user_browser_live');

		await expect(
			asUser.query(api.browserSessions.liveViewForThread, { threadId })
		).resolves.toBeNull();

		await t.mutation(internal.browserSessions.upsertForThread, {
			threadId,
			runId,
			userId,
			browserbaseSessionId: 'bb-1',
			liveViewUrl: 'https://live.browserbase.test/full'
		});

		const live = await asUser.query(api.browserSessions.liveViewForThread, { threadId });
		expect(live).toEqual({
			url: 'https://live.browserbase.test/full',
			lastUsedRunId: runId,
			startedAt: expect.any(Number)
		});

		const other = await seedOwnedThread(t, 'user_browser_other');
		await expect(
			other.asUser.query(api.browserSessions.liveViewForThread, { threadId })
		).rejects.toThrow('Thread not found.');
	});

	it('clears the stale live view URL when the session rotates without one', async () => {
		const t = initConvexTest();
		const { threadId, runId, userId } = await seedRun(t, 'user_browser_rotate');
		await t.mutation(internal.browserSessions.upsertForThread, {
			threadId,
			runId,
			userId,
			browserbaseSessionId: 'bb-old',
			liveViewUrl: 'https://live.browserbase.test/old'
		});

		await t.mutation(internal.browserSessions.upsertForThread, {
			threadId,
			runId,
			userId,
			browserbaseSessionId: 'bb-new'
		});

		const session = await t.query(internal.browserSessions.getForThread, { threadId, userId });
		expect(session?.browserbaseSessionId).toBe('bb-new');
		expect(session?.liveViewUrl).toBeUndefined();

		// A stale backfill for the rotated-away session must not stamp its URL
		// onto the new session's row.
		await t.mutation(internal.browserSessions.setLiveViewUrl, {
			threadId,
			browserbaseSessionId: 'bb-old',
			liveViewUrl: 'https://live.browserbase.test/stale'
		});
		expect(
			(await t.query(internal.browserSessions.getForThread, { threadId, userId }))?.liveViewUrl
		).toBeUndefined();

		await t.mutation(internal.browserSessions.setLiveViewUrl, {
			threadId,
			browserbaseSessionId: 'bb-new',
			liveViewUrl: 'https://live.browserbase.test/new'
		});
		const backfilled = await t.query(internal.browserSessions.getForThread, {
			threadId,
			userId
		});
		expect(backfilled?.liveViewUrl).toBe('https://live.browserbase.test/new');
		// Backfill does not refresh startedAt; it is not new agent activity.
		expect(backfilled?.startedAt).toBe(session?.startedAt);

		// An existing URL is never overwritten by the backfill path.
		await t.mutation(internal.browserSessions.setLiveViewUrl, {
			threadId,
			browserbaseSessionId: 'bb-new',
			liveViewUrl: 'https://live.browserbase.test/other'
		});
		const unchanged = await t.query(internal.browserSessions.getForThread, {
			threadId,
			userId
		});
		expect(unchanged?.liveViewUrl).toBe('https://live.browserbase.test/new');
	});

	it('tracks the run that last used the browser session', async () => {
		const t = initConvexTest();
		const first = await seedRun(t, 'user_browser_touch');
		await t.mutation(internal.browserSessions.upsertForThread, {
			threadId: first.threadId,
			runId: first.runId,
			userId: first.userId,
			browserbaseSessionId: 'bb-1'
		});

		let live = await first.asUser.query(api.browserSessions.liveViewForThread, {
			threadId: first.threadId
		});
		expect(live?.lastUsedRunId).toBe(first.runId);

		// A later run in the same thread reuses the session; touching it moves
		// lastUsedRunId without disturbing the session row.
		await t.run(async (ctx) => await ctx.db.patch('runs', first.runId, { status: 'completed' }));
		const secondRun = await createQueuedRun(
			t,
			first.asUser,
			first.threadId,
			`sub-${Math.random()}`,
			`secret-${Math.random()}`,
			'Browse more'
		);
		await t.mutation(internal.browserSessions.touchForThread, {
			threadId: first.threadId,
			runId: secondRun.runId
		});

		live = await first.asUser.query(api.browserSessions.liveViewForThread, {
			threadId: first.threadId
		});
		expect(live?.lastUsedRunId).toBe(secondRun.runId);

		const session = await t.query(internal.browserSessions.getForThread, {
			threadId: first.threadId,
			userId: first.userId
		});
		expect(session?.browserbaseSessionId).toBe('bb-1');
		expect(session?.runId).toBe(first.runId);
	});
});
