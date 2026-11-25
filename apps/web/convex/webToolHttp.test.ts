import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { api } from '@convex/_generated/api';
import { RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';
import { CONTEXT_DEV_CREDITS_EXHAUSTED, SCRAPE_CACHE_MAX_AGE_MS } from '@convex/lib/contextDev';
import { FIRECRAWL_CREDITS_EXHAUSTED } from '@convex/lib/firecrawl';
import { initConvexTest, seedStartedWebJob, type ConvexTestInstance } from './test.setup';

const PAGE_URL = 'https://example.com/page';

const EXECUTION_SECRET = 'web-tool-secret';

const providerFetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

async function seedScrapeJob(t: ConvexTestInstance) {
	return await seedStartedWebJob(t, {
		executionSecret: EXECUTION_SECRET,
		kind: 'scrape_url',
		payload: { url: PAGE_URL }
	});
}

function jobPath(
	path: string,
	job: { runId: string; claimId: string; jobId: string },
	extra: Record<string, string> = {}
) {
	const params = new URLSearchParams({
		runId: job.runId,
		claimId: job.claimId,
		jobId: job.jobId,
		...extra
	});

	return `${path}?${params}`;
}

function authorized(secret = EXECUTION_SECRET, init: RequestInit = {}): RequestInit {
	return {
		method: 'POST',
		...init,
		headers: { authorization: `Bearer ${secret}`, ...init.headers }
	};
}

function lastProviderRequest() {
	const call = providerFetch.mock.lastCall;

	if (!call) throw new Error('Expected a provider request.');

	return new Request(call[0], call[1]);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv('CONTEXT_DEV_API_KEY', 'context-dev-key');
	vi.stubEnv('FIRECRAWL_API_KEY', 'firecrawl-key');
	providerFetch.mockReset();
	vi.stubGlobal('fetch', providerFetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe('scrape endpoint', () => {
	it('streams the main-content markdown scrape of the job URL back', async () => {
		const t = initConvexTest();
		const job = await seedScrapeJob(t);
		const scrape = JSON.stringify({ url: PAGE_URL, markdown: { success: true, data: '# Page' } });
		providerFetch.mockResolvedValue(new Response(scrape, { status: 200 }));

		const response = await t.fetch(jobPath('/agent/scrape', job), authorized());

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(scrape);
		expect(await lastProviderRequest().json()).toMatchObject({
			url: PAGE_URL,
			formats: { markdown: true },
			markdownParams: { includeImages: true },
			sharedParams: { mainContentOnly: true },
			maxAgeMs: SCRAPE_CACHE_MAX_AGE_MS
		});
	});

	it('requests only bytes for a raw document', async () => {
		const t = initConvexTest();
		const job = await seedScrapeJob(t);
		providerFetch.mockResolvedValue(new Response('{}', { status: 200 }));

		await t.fetch(jobPath('/agent/scrape', job, { rawDocument: 'true' }), authorized());

		expect((await lastProviderRequest().json()).formats).toEqual({ bytes: true });
	});

	it('rejects a wrong execution secret or a settled job before calling context.dev', async () => {
		const t = initConvexTest();
		const job = await seedScrapeJob(t);

		const wrongSecret = await t.fetch(jobPath('/agent/scrape', job), authorized('other-secret'));

		await job.asUser.mutation(api.executor.complete, {
			runId: job.runId,
			claimId: job.claimId,
			executionSecret: EXECUTION_SECRET,
			jobId: job.jobId,
			result: { url: PAGE_URL, markdown: 'done' }
		});
		const settled = await t.fetch(jobPath('/agent/scrape', job), authorized());

		for (const response of [wrongSecret, settled]) {
			expect(response.status).toBe(409);
			expect(await response.text()).toBe(RUN_NO_LONGER_ACTIVE);
		}

		expect(providerFetch).not.toHaveBeenCalled();
	});

	it('waits out Retry-After on a rate limit, then retries', async () => {
		const t = initConvexTest();
		const job = await seedScrapeJob(t);

		providerFetch
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ message: 'Slow down' }), {
					status: 429,
					headers: { 'retry-after': '30' }
				})
			)
			.mockResolvedValueOnce(new Response('{}', { status: 200 }));

		const response = t.fetch(jobPath('/agent/scrape', job), authorized());

		await vi.waitFor(() => expect(providerFetch).toHaveBeenCalledTimes(1));
		await vi.advanceTimersByTimeAsync(29_000);
		expect(providerFetch).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(2_000);
		expect((await response).status).toBe(200);
		expect(providerFetch).toHaveBeenCalledTimes(2);
	});

	it('reports exhausted context.dev credits', async () => {
		const t = initConvexTest();
		const job = await seedScrapeJob(t);

		providerFetch.mockResolvedValue(
			new Response(JSON.stringify({ error_code: 'USAGE_EXCEEDED' }), { status: 401 })
		);

		const response = await t.fetch(jobPath('/agent/scrape', job), authorized());

		expect(response.status).toBe(502);
		expect(await response.text()).toBe(CONTEXT_DEV_CREDITS_EXHAUSTED);
	});
});

describe('parse endpoint', () => {
	function upload(body: string) {
		return authorized(EXECUTION_SECRET, {
			body,
			headers: { 'content-length': String(new TextEncoder().encode(body).byteLength) }
		});
	}

	it('streams the file to Firecrawl as multipart and its result back', async () => {
		const t = initConvexTest();
		const job = await seedScrapeJob(t);
		const parsed = JSON.stringify({ success: true, data: { markdown: '# Report' } });
		providerFetch.mockResolvedValue(new Response(parsed, { status: 200 }));

		const response = await t.fetch(
			jobPath('/agent/parse', job, { filename: 'dir/report.pdf', pages: 'true' }),
			upload('%PDF-1.4')
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(parsed);

		const request = lastProviderRequest();
		const sent = await request.text();
		expect(request.headers.get('content-length')).toBe(String(sent.length));

		const form = await new Request(request.url, {
			method: 'POST',
			headers: { 'content-type': request.headers.get('content-type')! },
			body: sent
		}).formData();

		const file = z.instanceof(File).parse(form.get('file'));

		expect(file.name).toBe('report.pdf');
		expect(await file.text()).toBe('%PDF-1.4');
		expect(JSON.parse(z.string().parse(form.get('options')))).toMatchObject({
			formats: ['markdown'],
			parsers: [{ type: 'pdf', mode: 'auto', pages: true }]
		});
	});

	it('reports exhausted Firecrawl credits', async () => {
		const t = initConvexTest();
		const job = await seedScrapeJob(t);
		providerFetch.mockResolvedValue(new Response('{}', { status: 402 }));

		const response = await t.fetch(
			jobPath('/agent/parse', job, { filename: 'report.pdf' }),
			upload('%PDF-1.4')
		);

		expect(response.status).toBe(502);
		expect(await response.text()).toBe(FIRECRAWL_CREDITS_EXHAUSTED);
	});
});
