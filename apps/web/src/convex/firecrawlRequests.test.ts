import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patchRunExecution } from '@convex/lib/runExecution';
import { FirecrawlClient } from '@firecrawl/firecrawl-convex';
import { api, internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { REQUEST_TTL_MS } from '@convex/firecrawlRequests';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	toolTranscriptAssignment,
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
		...toolTranscriptAssignment(runId, secret),
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

	it('limits scrapes to two at a time', async () => {
		const t = initConvexTest();
		const auth = await fixture(t, true);
		const gate = Promise.withResolvers<{ markdown: string }>();
		const scrape = vi
			.spyOn(FirecrawlClient.prototype, 'scrape')
			.mockImplementation(() => gate.promise);
		const ids = [];
		for (let i = 0; i < 3; i++)
			ids.push(await t.mutation(api.firecrawlRequests.start, { ...auth, kind: 'scrape' }));
		try {
			await vi.waitFor(() => expect(scrape).toHaveBeenCalledTimes(2));
			await vi.advanceTimersByTimeAsync(1_000);
			expect(scrape).toHaveBeenCalledTimes(2);
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

	it('rejects a stale claim before queued work reaches the provider', async () => {
		const t = initConvexTest();
		const auth = await fixture(t, true);
		const scrape = vi.spyOn(FirecrawlClient.prototype, 'scrape');
		const id = await t.mutation(api.firecrawlRequests.start, { ...auth, kind: 'scrape' });
		await t.run((ctx) => patchRunExecution(ctx, auth.runId, { claimId: 'replacement' }));
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
					change === 'cancel'
						? ctx.db.patch('runs', auth.runId, { cancellationRequestedAt: Date.now() })
						: patchRunExecution(ctx, auth.runId, { claimId: 'replacement' })
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
