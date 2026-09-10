import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirecrawlClient } from '@firecrawl/firecrawl-convex';
import { api, internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { REQUEST_TTL_MS } from '@convex/firecrawlRequests';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	type ConvexTestInstance
} from '@convex/test.setup';

async function fixture(t: ConvexTestInstance, scrape = false) {
	const secret = crypto.randomUUID();
	const { asUser, threadId } = await seedOwnedThread(t, secret);
	const { runId } = await createQueuedRun(t, asUser, threadId, secret, secret);
	const auth = { runId, claimId: secret, executionSecret: secret };
	await t.mutation(api.agentRuntime.start, auth);
	if (!scrape) return { ...auth, jobId: undefined };
	const { jobId } = await t.mutation(api.agentRuntime.beginToolJob, {
		...auth,
		kind: 'scrape_url',
		payload: { url: 'https://example.com' }
	});
	return { ...auth, jobId };
}

function resultArgs(auth: Awaited<ReturnType<typeof fixture>>, id: Id<'firecrawlRequests'>) {
	return { id, runId: auth.runId, executionSecret: auth.executionSecret };
}

async function settled(
	t: ConvexTestInstance,
	auth: Awaited<ReturnType<typeof fixture>>,
	id: Id<'firecrawlRequests'>
) {
	await vi.waitFor(
		async () => {
			expect(
				(await t.query(api.firecrawlRequests.getResult, resultArgs(auth, id))).status
			).not.toBe('pending');
		},
		{ timeout: 3_000, interval: 10 }
	);
	return t.query(api.firecrawlRequests.getResult, resultArgs(auth, id));
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv('FIRECRAWL_API_KEY', 'scrape-key');
	vi.stubEnv('FIRECRAWL_BROWSER_API_KEY', 'browser-key');
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('Firecrawl request queue', () => {
	it('uses storage for results, claims only once, and disposes both the row and blob', async () => {
		const t = initConvexTest();
		const auth = await fixture(t, true);
		const scrape = vi
			.spyOn(FirecrawlClient.prototype, 'scrape')
			.mockResolvedValue({ markdown: '# Page' });
		const id = await t.mutation(api.firecrawlRequests.start, { ...auth, kind: 'scrape' });
		expect(await t.query(api.firecrawlRequests.getResult, resultArgs(auth, id))).toEqual({
			status: 'pending'
		});
		expect(await settled(t, auth, id)).toMatchObject({
			status: 'completed',
			url: expect.any(String)
		});
		await t.action(internal.firecrawlRequestActions.execute, { id });
		expect(scrape).toHaveBeenCalledTimes(1);
		const request = await t.run((ctx) => ctx.db.get('firecrawlRequests', id));
		expect(request).not.toHaveProperty('result');
		expect(
			await t.run(async (ctx) => (await ctx.storage.get(request!.resultStorageId!))?.text())
		).toContain('# Page');
		await t.mutation(api.firecrawlRequests.dispose, resultArgs(auth, id));
		expect(await t.run((ctx) => ctx.db.get('firecrawlRequests', id))).toBeNull();
		expect(await t.run((ctx) => ctx.storage.get(request!.resultStorageId!))).toBeNull();
	});

	it("authenticates all public operations and does not expose another run's result", async () => {
		const t = initConvexTest();
		const auth = await fixture(t, true);
		await expect(
			t.mutation(api.firecrawlRequests.start, { ...auth, executionSecret: 'wrong', kind: 'scrape' })
		).rejects.toThrow('Run not found');
		const id = await t.mutation(api.firecrawlRequests.start, { ...auth, kind: 'scrape' });
		const args = resultArgs(auth, id);
		await expect(
			t.query(api.firecrawlRequests.getResult, { ...args, executionSecret: 'wrong' })
		).rejects.toThrow('Run not found');
		await expect(
			t.mutation(api.firecrawlRequests.dispose, { ...args, executionSecret: 'wrong' })
		).rejects.toThrow('Run not found');
		const other = await fixture(t);
		expect(await t.query(api.firecrawlRequests.getResult, resultArgs(other, id))).toMatchObject({
			status: 'failed'
		});
		await t.mutation(api.firecrawlRequests.dispose, resultArgs(other, id));
		expect(await t.run((ctx) => ctx.db.get('firecrawlRequests', id))).not.toBeNull();
		await t.mutation(api.firecrawlRequests.dispose, args);
	});

	it('never falls back to the scrape key for browsers', async () => {
		vi.stubEnv('FIRECRAWL_BROWSER_API_KEY', '   ');
		const t = initConvexTest();
		const auth = await fixture(t);
		await expect(
			t.mutation(api.firecrawlRequests.start, {
				...auth,
				kind: 'browser_interact',
				command: 'get url'
			})
		).rejects.toThrow('FIRECRAWL_BROWSER_API_KEY');
		expect(await t.run((ctx) => ctx.db.query('firecrawlRequests').collect())).toEqual([]);
	});

	it('limits scrapes to two and lets browser work proceed while both scrapes are blocked', async () => {
		const t = initConvexTest();
		const auth = await fixture(t, true);
		const gate = Promise.withResolvers<{ markdown: string }>();
		const scrape = vi
			.spyOn(FirecrawlClient.prototype, 'scrape')
			.mockImplementation(() => gate.promise);
		const fetch = vi.fn(async (_url: string, options: RequestInit) => {
			expect(options.headers).toMatchObject({ Authorization: 'Bearer browser-key' });
			return new Response('{}', { status: 503 });
		});
		vi.stubGlobal('fetch', fetch);
		const ids = [];
		for (let i = 0; i < 3; i++)
			ids.push(await t.mutation(api.firecrawlRequests.start, { ...auth, kind: 'scrape' }));
		try {
			await vi.waitFor(() => expect(scrape).toHaveBeenCalledTimes(2));
			await vi.advanceTimersByTimeAsync(1_000);
			expect(scrape).toHaveBeenCalledTimes(2);
			const browser = await fixture(t);
			const id = await t.mutation(api.firecrawlRequests.start, {
				...browser,
				kind: 'browser_interact',
				command: 'get url'
			});
			expect(await settled(t, browser, id)).toMatchObject({ status: 'failed' });
			await vi.advanceTimersByTimeAsync(5_000);
			expect(fetch).toHaveBeenCalledTimes(1);
		} finally {
			gate.resolve({ markdown: 'Done' });
			for (const id of ids) await settled(t, auth, id);
		}
		expect(scrape).toHaveBeenCalledTimes(3);
	});

	it('cancels queued work before it reaches the provider', async () => {
		const t = initConvexTest();
		const auth = await fixture(t, true);
		const scrape = vi.spyOn(FirecrawlClient.prototype, 'scrape');
		const id = await t.mutation(api.firecrawlRequests.start, { ...auth, kind: 'scrape' });
		await t.mutation(internal.firecrawlRequests.cancelRun, { runId: auth.runId });
		await vi.advanceTimersByTimeAsync(1_000);
		await t.finishInProgressScheduledFunctions();
		expect(scrape).not.toHaveBeenCalled();
		expect(await t.query(api.firecrawlRequests.getResult, resultArgs(auth, id))).toMatchObject({
			status: 'failed'
		});
	});

	it('limits browser commands to two without blocking scrape work or session deletion', async () => {
		const t = initConvexTest();
		const browsers = [await fixture(t), await fixture(t), await fixture(t)];
		const gate = Promise.withResolvers<void>();
		let sessions = 0;
		let executions = 0;
		const fetch = vi.fn(async (url: string, options: RequestInit) => {
			if (url.endsWith('/execute')) {
				executions++;
				await gate.promise;
			} else if (options.method === 'POST') {
				return Response.json({
					success: true,
					id: `browser-${++sessions}`,
					expiresAt: new Date(Date.now() + 3_600_000).toISOString()
				});
			}
			return Response.json({ success: true, stdout: 'Done', exitCode: 0 });
		});
		vi.stubGlobal('fetch', fetch);
		const ids = [];
		for (const auth of browsers)
			ids.push(
				await t.mutation(api.firecrawlRequests.start, {
					...auth,
					kind: 'browser_interact',
					command: 'get url'
				})
			);
		try {
			await vi.waitFor(() => expect(executions).toBe(2));
			await vi.advanceTimersByTimeAsync(1_000);
			expect(sessions).toBe(2);
			expect(executions).toBe(2);
			const scrapeAuth = await fixture(t, true);
			vi.spyOn(FirecrawlClient.prototype, 'scrape').mockResolvedValue({ markdown: 'Independent' });
			const scrapeId = await t.mutation(api.firecrawlRequests.start, {
				...scrapeAuth,
				kind: 'scrape'
			});
			expect(await settled(t, scrapeAuth, scrapeId)).toMatchObject({ status: 'completed' });
			const run = await t.run((ctx) => ctx.db.get('runs', browsers[0].runId));
			const session = await t.run((ctx) =>
				ctx.db
					.query('browserSessions')
					.withIndex('by_threadId', (q) => q.eq('threadId', run!.threadId))
					.unique()
			);
			await t
				.withIdentity({ subject: browsers[0].executionSecret })
				.mutation(api.browserSessions.stop, {
					id: session!._id,
					providerSessionId: session!.sessionId!
				});
			await vi.waitFor(() =>
				expect(fetch.mock.calls.some(([, options]) => options.method === 'DELETE')).toBe(true)
			);
			expect(executions).toBe(2);
		} finally {
			gate.resolve();
			for (const [index, id] of ids.entries()) await settled(t, browsers[index], id);
		}
	});

	it('rejects a stale claim before queued work reaches the provider', async () => {
		const t = initConvexTest();
		const auth = await fixture(t, true);
		const scrape = vi.spyOn(FirecrawlClient.prototype, 'scrape');
		const id = await t.mutation(api.firecrawlRequests.start, { ...auth, kind: 'scrape' });
		await t.run((ctx) => ctx.db.patch('runs', auth.runId, { claimId: 'replacement' }));
		await vi.advanceTimersByTimeAsync(1_000);
		await t.finishInProgressScheduledFunctions();
		expect(scrape).not.toHaveBeenCalled();
		expect(await t.query(api.firecrawlRequests.getResult, resultArgs(auth, id))).toMatchObject({
			status: 'failed'
		});
	});

	it.each(['cancel', 'takeover', 'expire'] as const)(
		'discards results after %s without replaying work',
		async (change) => {
			const t = initConvexTest();
			const auth = await fixture(t, true);
			const gate = Promise.withResolvers<{ markdown: string }>();
			const scrape = vi
				.spyOn(FirecrawlClient.prototype, 'scrape')
				.mockImplementation(() => gate.promise);
			const id = await t.mutation(api.firecrawlRequests.start, { ...auth, kind: 'scrape' });
			await vi.waitFor(() => expect(scrape).toHaveBeenCalledTimes(1));
			if (change === 'expire') await vi.advanceTimersByTimeAsync(REQUEST_TTL_MS);
			else
				await t.run((ctx) =>
					ctx.db.patch(
						'runs',
						auth.runId,
						change === 'cancel'
							? { cancellationRequestedAt: Date.now() }
							: { claimId: 'replacement' }
					)
				);
			gate.resolve({ markdown: 'Too late' });
			await t.finishInProgressScheduledFunctions();
			await vi.advanceTimersByTimeAsync(1_000);
			await t.finishInProgressScheduledFunctions();
			expect(await t.query(api.firecrawlRequests.getResult, resultArgs(auth, id))).toMatchObject({
				status: 'failed'
			});
			expect(await t.run((ctx) => ctx.db.system.query('_storage').collect())).toEqual([]);
			expect(scrape).toHaveBeenCalledTimes(1);
		}
	);
});
