import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIError } from 'context.dev';
import { Web, type WebScrapeResponse } from 'context.dev/resources/web';
import { Firecrawl } from 'firecrawl';
import { patchRunExecution } from '@convex/lib/runExecution';
import { api, internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { REQUEST_TTL_MS } from '@convex/webRequests';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	toolTranscriptAssignment,
	type ConvexTestInstance
} from '@convex/test.setup';

type Job =
	| { kind: 'scrape_url'; payload: { url: string } }
	| { kind: 'developer_search'; payload: { query: string } };

const scrapeJob: Job = { kind: 'scrape_url', payload: { url: 'https://example.com' } };

async function fixture(t: ConvexTestInstance, job?: Job) {
	const secret: string = crypto.randomUUID();
	const { asUser, threadId } = await seedOwnedThread(t, secret);
	const { runId } = await createQueuedRun(t, asUser, threadId, secret, secret);
	const auth = { runId, claimId: secret, executionSecret: secret };
	await t.mutation(api.agentRuntime.start, auth);

	if (!job) return { ...auth, jobId: undefined };

	const { jobId } = await t.mutation(api.agentRuntime.beginToolJob, {
		...auth,
		...toolTranscriptAssignment(runId, secret),
		...job
	});

	return { ...auth, jobId };
}

type Auth = Awaited<ReturnType<typeof fixture>>;

async function startScrape(t: ConvexTestInstance, auth: Auth) {
	return await t.mutation(api.webRequests.start, { ...auth, jobId: auth.jobId!, kind: 'scrape' });
}

function resultArgs(auth: Auth, id: Id<'webRequests'>) {
	return { id, runId: auth.runId, executionSecret: auth.executionSecret };
}

async function settled(t: ConvexTestInstance, auth: Auth, id: Id<'webRequests'>) {
	await vi.waitFor(
		async () => {
			expect((await t.query(api.webRequests.getResult, resultArgs(auth, id))).status).not.toBe(
				'pending'
			);
		},
		{ timeout: 3_000, interval: 10 }
	);

	return t.query(api.webRequests.getResult, resultArgs(auth, id));
}

async function storedResult(t: ConvexTestInstance, id: Id<'webRequests'>) {
	const request = await t.run((ctx) => ctx.db.get('webRequests', id));

	return await t.run(async (ctx) => (await ctx.storage.get(request!.resultStorageId!))?.text());
}

function page(markdown: string): WebScrapeResponse {
	// SAFETY: The scrape only reads these fields.
	return {
		url: 'https://example.com',
		markdown: { success: true, data: markdown },
		images: { success: true, data: [] },
		metadata: { headings: [] }
	} as never;
}

function mockScrape(result: () => Promise<WebScrapeResponse>) {
	// SAFETY: The SDK's APIPromise is only awaited.
	return vi.spyOn(Web.prototype, 'scrape').mockImplementation(result as never);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv('CONTEXT_DEV_API_KEY', 'context-key');
	vi.stubEnv('FIRECRAWL_API_KEY', 'firecrawl-key');
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe('web request queue', () => {
	it('uses storage for results, claims only once, and disposes both the row and blob', async () => {
		const t = initConvexTest();
		const auth = await fixture(t, scrapeJob);
		const scrape = mockScrape(async () => page('# Page'));

		const id = await startScrape(t, auth);
		expect(await t.query(api.webRequests.getResult, resultArgs(auth, id))).toEqual({
			status: 'pending'
		});
		expect(await settled(t, auth, id)).toMatchObject({
			status: 'completed',
			url: expect.any(String)
		});
		await t.action(internal.webRequestActions.execute, { id });
		expect(scrape).toHaveBeenCalledTimes(1);
		const request = await t.run((ctx) => ctx.db.get('webRequests', id));
		expect(await storedResult(t, id)).toContain('# Page');
		await t.mutation(api.webRequests.dispose, resultArgs(auth, id));
		expect(await t.run((ctx) => ctx.db.get('webRequests', id))).toBeNull();
		expect(await t.run((ctx) => ctx.storage.get(request!.resultStorageId!))).toBeNull();
	});

	it('runs developer searches for developer_search jobs', async () => {
		const t = initConvexTest();
		const auth = await fixture(t, { kind: 'developer_search', payload: { query: 'workpool' } });

		const search = vi.spyOn(Firecrawl.prototype, 'developerSearch').mockResolvedValue({
			success: true,
			results: [{ id: 'a', url: 'https://docs.example.com', passages: [{ text: 'Pools' }] }]
		});

		const id = await t.mutation(api.webRequests.start, {
			...auth,
			jobId: auth.jobId!,
			kind: 'developer_search'
		});

		expect(await settled(t, auth, id)).toMatchObject({ status: 'completed' });
		expect(search).toHaveBeenCalledOnce();
		expect(JSON.parse((await storedResult(t, id))!)).toEqual({
			results: [{ url: 'https://docs.example.com', passages: [{ text: 'Pools' }] }]
		});
	});

	it('rejects requests whose kind does not match the job', async () => {
		const t = initConvexTest();
		const auth = await fixture(t, scrapeJob);
		await expect(
			t.mutation(api.webRequests.start, { ...auth, jobId: auth.jobId!, kind: 'developer_search' })
		).rejects.toThrow('Run is no longer active');
	});

	it("authenticates all public operations and does not expose another run's result", async () => {
		const t = initConvexTest();
		const auth = await fixture(t, scrapeJob);
		mockScrape(async () => page('# Page'));
		await expect(startScrape(t, { ...auth, executionSecret: 'wrong' })).rejects.toThrow(
			'Run not found'
		);
		const id = await startScrape(t, auth);
		const args = resultArgs(auth, id);
		await expect(
			t.query(api.webRequests.getResult, { ...args, executionSecret: 'wrong' })
		).rejects.toThrow('Run not found');
		await expect(
			t.mutation(api.webRequests.dispose, { ...args, executionSecret: 'wrong' })
		).rejects.toThrow('Run not found');
		const other = await fixture(t);
		expect(await t.query(api.webRequests.getResult, resultArgs(other, id))).toMatchObject({
			status: 'failed'
		});
		await t.mutation(api.webRequests.dispose, resultArgs(other, id));
		expect(await t.run((ctx) => ctx.db.get('webRequests', id))).not.toBeNull();
		await t.mutation(api.webRequests.dispose, args);
	});

	it('runs one context.dev scrape at a time', async () => {
		const t = initConvexTest();
		const auth = await fixture(t, scrapeJob);
		const gate = Promise.withResolvers<WebScrapeResponse>();
		const scrape = mockScrape(() => gate.promise);
		const ids = [];

		for (let i = 0; i < 2; i++) ids.push(await startScrape(t, auth));

		try {
			await vi.waitFor(() => expect(scrape).toHaveBeenCalledTimes(1));
			await vi.advanceTimersByTimeAsync(1_000);
			expect(scrape).toHaveBeenCalledTimes(1);
		} finally {
			gate.resolve(page('Done'));

			for (const id of ids) await settled(t, auth, id);
		}

		expect(scrape).toHaveBeenCalledTimes(2);
	});

	it('cancels queued work before it reaches the provider', async () => {
		const t = initConvexTest();
		const auth = await fixture(t, scrapeJob);
		const scrape = mockScrape(async () => page('# Page'));
		const id = await startScrape(t, auth);
		await t.mutation(internal.webRequests.cancelRun, { runId: auth.runId });
		await vi.advanceTimersByTimeAsync(1_000);
		await t.finishInProgressScheduledFunctions();
		expect(scrape).not.toHaveBeenCalled();
		expect(await t.query(api.webRequests.getResult, resultArgs(auth, id))).toMatchObject({
			status: 'failed'
		});
	});

	it('rejects a stale claim before queued work reaches the provider', async () => {
		const t = initConvexTest();
		const auth = await fixture(t, scrapeJob);
		const scrape = mockScrape(async () => page('# Page'));
		const id = await startScrape(t, auth);
		await t.run((ctx) => patchRunExecution(ctx, auth.runId, { claimId: 'replacement' }));
		await vi.advanceTimersByTimeAsync(1_000);
		await t.finishInProgressScheduledFunctions();
		expect(scrape).not.toHaveBeenCalled();
		expect(await t.query(api.webRequests.getResult, resultArgs(auth, id))).toMatchObject({
			status: 'failed'
		});
	});

	it.each(['cancel', 'takeover', 'expire'] as const)(
		'discards results after %s without replaying work',
		async (change) => {
			const t = initConvexTest();
			const auth = await fixture(t, scrapeJob);
			const gate = Promise.withResolvers<WebScrapeResponse>();
			const scrape = mockScrape(() => gate.promise);
			const id = await startScrape(t, auth);
			await vi.waitFor(() => expect(scrape).toHaveBeenCalledTimes(1));

			if (change === 'expire') await vi.advanceTimersByTimeAsync(REQUEST_TTL_MS);
			else
				await t.run((ctx) =>
					change === 'cancel'
						? ctx.db.patch('runs', auth.runId, { cancellationRequestedAt: Date.now() })
						: patchRunExecution(ctx, auth.runId, { claimId: 'replacement' })
				);
			gate.resolve(page('Too late'));
			await t.finishInProgressScheduledFunctions();
			await vi.advanceTimersByTimeAsync(1_000);
			await t.finishInProgressScheduledFunctions();
			expect(await t.query(api.webRequests.getResult, resultArgs(auth, id))).toMatchObject({
				status: 'failed'
			});
			expect(await t.run((ctx) => ctx.db.system.query('_storage').collect())).toEqual([]);
			expect(scrape).toHaveBeenCalledTimes(1);
		}
	);

	it('stops retrying a rate-limited scrape once the run is cancelled', async () => {
		const t = initConvexTest();
		const auth = await fixture(t, scrapeJob);

		const scrape = vi
			.spyOn(Web.prototype, 'scrape')
			.mockRejectedValue(
				APIError.generate(429, {}, undefined, new Headers({ 'retry-after': '5' }))
			);

		const id = await startScrape(t, auth);

		await vi.waitFor(() => expect(scrape).toHaveBeenCalledTimes(1));

		await t.run((ctx) => ctx.db.patch('runs', auth.runId, { cancellationRequestedAt: Date.now() }));
		await vi.advanceTimersByTimeAsync(10_000);
		await t.finishInProgressScheduledFunctions();
		expect(scrape).toHaveBeenCalledTimes(1);
		expect(await t.query(api.webRequests.getResult, resultArgs(auth, id))).toMatchObject({
			status: 'failed'
		});
	});
});

describe('legacy firecrawlRequests endpoints', () => {
	it('serve scrapes for released agents', async () => {
		const t = initConvexTest();
		const auth = await fixture(t, scrapeJob);
		mockScrape(async () => page('# Legacy'));
		const legacy = { runId: auth.runId, executionSecret: auth.executionSecret };

		const id = await t.mutation(api.firecrawlRequests.start, { ...auth, kind: 'scrape' });
		await vi.waitFor(
			async () => {
				expect((await t.query(api.firecrawlRequests.getResult, { ...legacy, id })).status).toBe(
					'completed'
				);
			},
			{ timeout: 3_000, interval: 10 }
		);
		await t.mutation(api.firecrawlRequests.dispose, { ...legacy, id });
		expect(await t.run((ctx) => ctx.db.query('webRequests').collect())).toEqual([]);
	});

	it('report pre-rename request IDs as ended', async () => {
		const t = initConvexTest();
		const auth = await fixture(t);
		expect(
			await t.query(api.firecrawlRequests.getResult, {
				id: 'not-a-web-request',
				runId: auth.runId,
				executionSecret: auth.executionSecret
			})
		).toMatchObject({ status: 'failed' });
	});
});

describe('screenshot_url', () => {
	it('fails the job with an unsupported-tool error for released agents', async () => {
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		const auth = { runId, claimId, executionSecret };

		const { jobId } = await t.mutation(api.agentRuntime.beginToolJob, {
			...auth,
			...toolTranscriptAssignment(auth.runId, auth.claimId),
			kind: 'screenshot_url',
			payload: { url: 'https://example.com' }
		});

		await expect(
			t.mutation(api.firecrawlRequests.start, { ...auth, jobId, kind: 'screenshot' })
		).rejects.toThrow('This tool is no longer supported.');
		expect(
			await t.mutation(api.executor.fail, {
				...auth,
				jobId,
				error: 'This tool is no longer supported.'
			})
		).toBe(true);
		expect(await t.run((ctx) => ctx.db.get('executorJobs', jobId))).toMatchObject({
			status: 'failed',
			error: 'This tool is no longer supported.'
		});
	});
});
