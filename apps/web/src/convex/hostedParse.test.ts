/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkId } from '@convex-dev/workpool';
import type { GenericDatabaseWriter, GenericDataModel, SystemDataModel } from 'convex/server';
import { api, internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import {
	FIRECRAWL_PARSE_URL,
	HOSTED_PARSE_MAX_OUTPUT_BYTES,
	parseFirecrawlParseResponse
} from '@convex/lib/hostedParse';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	type ConvexTestInstance
} from '@convex/test.setup';

async function seedParseJob(
	t: ConvexTestInstance,
	options: {
		executionSecret: string;
		kind?: 'parse_file' | 'web_search';
		claimId?: string;
	}
) {
	const claimId = options.claimId ?? `claim-${Math.random()}`;
	const { asUser, threadId, subject } = await seedOwnedThread(t);
	const created = await createQueuedRun(
		t,
		asUser,
		threadId,
		`hosted-parse-${Math.random()}`,
		options.executionSecret,
		'Parse a file'
	);
	await asUser.mutation(api.agentRuntime.start, {
		runId: created.runId,
		claimId,
		executionSecret: options.executionSecret
	});
	const jobId = await t.run(async (ctx) => {
		const jobId = await ctx.db.insert('executorJobs', {
			threadId,
			runId: created.runId,
			kind: options.kind ?? 'parse_file',
			payload: options.kind === 'web_search' ? { query: 'sprocket' } : { path: '/tmp/doc.pdf' },
			hidden: false,
			status: 'claimed',
			enqueuedAt: Date.now(),
			claimedAt: Date.now(),
			sequence: 0
		});
		await ctx.db.patch('runs', created.runId, {
			status: 'awaiting_executor',
			activeJobId: jobId
		});
		return jobId;
	});
	return {
		asUser,
		subject,
		runId: created.runId,
		jobId,
		claimId,
		executionSecret: options.executionSecret
	};
}

async function storeBlob(
	t: ConvexTestInstance,
	args: { bytes: string; type?: string; size?: number }
) {
	return await t.run(async (ctx) => {
		const blob =
			args.type === undefined
				? new Blob([args.bytes])
				: new Blob([args.bytes], { type: args.type });
		const storageId = await ctx.storage.store(blob);
		if (args.type || args.size !== undefined) {
			const db: GenericDatabaseWriter<GenericDataModel> = ctx.db;
			const metadata: Partial<SystemDataModel['_storage']['document']> = {};
			if (args.type) metadata.contentType = args.type;
			if (args.size !== undefined) metadata.size = args.size;
			await db.patch(storageId, metadata);
		}
		return storageId;
	});
}

function auth(run: Awaited<ReturnType<typeof seedParseJob>>) {
	return { runId: run.runId, claimId: run.claimId, executionSecret: run.executionSecret };
}

function workId(job: Doc<'executorJobs'> | null): WorkId {
	if (!job?.cloudWorkId) throw new Error('Expected an enqueued parse job');
	// SAFETY: start stores the ID returned by Workpool.enqueueAction without changing it.
	return job.cloudWorkId as WorkId;
}

describe('Firecrawl parse response contract', () => {
	it('requires markdown and rejects truncated PDFs', () => {
		expect(
			parseFirecrawlParseResponse(
				JSON.stringify({
					success: true,
					data: {
						markdown: '# Report',
						metadata: { numPages: 2, totalPages: 2 }
					}
				}),
				64
			)
		).toEqual({ markdown: '# Report' });
		expect(
			parseFirecrawlParseResponse(
				JSON.stringify({
					success: true,
					data: {
						markdown: '# Partial',
						metadata: { numPages: 2, totalPages: 10 }
					}
				}),
				64
			)
		).toEqual({ error: 'Parsed document was truncated.' });
		expect(parseFirecrawlParseResponse(JSON.stringify({ success: true, data: {} }), 8)).toEqual({
			error: 'Firecrawl parse did not return markdown.'
		});
		expect(
			parseFirecrawlParseResponse(JSON.stringify({ success: false, error: 'Payment required' }), 32)
		).toEqual({
			error: 'Payment required'
		});
		expect(
			parseFirecrawlParseResponse(JSON.stringify({ success: true, data: { markdown: 'x' } }), 64)
		).toEqual({
			markdown: 'x'
		});
	});

	it('rejects oversized provider payloads', () => {
		expect(
			parseFirecrawlParseResponse(
				JSON.stringify({ success: true, data: { markdown: '# huge' } }),
				HOSTED_PARSE_MAX_OUTPUT_BYTES + 1
			)
		).toEqual({ error: 'Firecrawl parse response is too large.' });
	});
});

describe('hostedParse', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv('FIRECRAWL_API_KEY', 'fc-test-key');
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it('gates createUpload on a configured server API key', async () => {
		delete process.env.FIRECRAWL_API_KEY;
		const t = initConvexTest();
		const run = await seedParseJob(t, { executionSecret: 'hosted-config-secret' });
		await expect(
			run.asUser.mutation(api.hostedParse.createUpload, { ...auth(run), jobId: run.jobId })
		).rejects.toThrow('Hosted document parsing is not configured.');
	});

	it('rejects createUpload without a valid execution secret or claim', async () => {
		const t = initConvexTest();
		const run = await seedParseJob(t, { executionSecret: 'hosted-auth-secret' });
		await expect(
			run.asUser.mutation(api.hostedParse.createUpload, {
				runId: run.runId,
				claimId: run.claimId,
				executionSecret: 'wrong-secret',
				jobId: run.jobId
			})
		).rejects.toThrow('Run not found.');
		await expect(
			run.asUser.mutation(api.hostedParse.createUpload, {
				runId: run.runId,
				claimId: 'other-claim',
				executionSecret: run.executionSecret,
				jobId: run.jobId
			})
		).rejects.toThrow('Run is no longer active.');
	});

	it('rejects createUpload for non parse_file jobs', async () => {
		const t = initConvexTest();
		const run = await seedParseJob(t, {
			executionSecret: 'hosted-kind-secret',
			kind: 'web_search'
		});
		await expect(
			run.asUser.mutation(api.hostedParse.createUpload, { ...auth(run), jobId: run.jobId })
		).rejects.toThrow('Executor job not found.');
	});

	it('reuses the same upload URL while awaiting upload and omits it after start', async () => {
		const t = initConvexTest();
		const run = await seedParseJob(t, { executionSecret: 'hosted-idempotent-secret' });
		const first = await run.asUser.mutation(api.hostedParse.createUpload, {
			...auth(run),
			jobId: run.jobId
		});
		const second = await run.asUser.mutation(api.hostedParse.createUpload, {
			...auth(run),
			jobId: run.jobId
		});
		expect(second.requestId).toBe(first.requestId);
		expect(second.uploadUrl).toBe(first.uploadUrl);
		expect(first.uploadUrl).toEqual(expect.any(String));

		const storageId = await storeBlob(t, { bytes: '%PDF-1.4', type: 'application/pdf' });
		await run.asUser.mutation(api.hostedParse.start, {
			...auth(run),
			requestId: first.requestId,
			storageId,
			filename: 'spec.pdf'
		});
		const afterStart = await run.asUser.mutation(api.hostedParse.createUpload, {
			...auth(run),
			jobId: run.jobId
		});
		expect(afterStart.requestId).toBe(first.requestId);
		expect(afterStart.uploadUrl).toBeUndefined();
		const pending = await run.asUser.query(api.hostedParse.getResult, {
			runId: run.runId,
			executionSecret: run.executionSecret,
			requestId: first.requestId
		});
		expect(pending).toEqual({ status: 'pending' });
	});

	it('does not enqueue a second provider job when start is retried', async () => {
		const t = initConvexTest();
		const run = await seedParseJob(t, { executionSecret: 'hosted-start-once-secret' });
		const created = await run.asUser.mutation(api.hostedParse.createUpload, {
			...auth(run),
			jobId: run.jobId
		});
		const firstStorage = await storeBlob(t, { bytes: 'doc-one', type: 'application/pdf' });
		await run.asUser.mutation(api.hostedParse.start, {
			...auth(run),
			requestId: created.requestId,
			storageId: firstStorage,
			filename: 'one.pdf'
		});
		const firstJob = await t.run(async (ctx) => ctx.db.get('executorJobs', run.jobId));
		const secondStorage = await storeBlob(t, { bytes: 'doc-two', type: 'application/pdf' });
		await run.asUser.mutation(api.hostedParse.start, {
			...auth(run),
			requestId: created.requestId,
			storageId: secondStorage,
			filename: 'two.pdf'
		});
		const secondJob = await t.run(async (ctx) => ctx.db.get('executorJobs', run.jobId));
		expect(secondJob?.cloudWorkId).toBe(firstJob?.cloudWorkId);
		expect(secondJob?.cloudWorkId).toEqual(expect.any(String));
		const request = await t.run(async (ctx) =>
			ctx.db.get('hostedParseRequests', created.requestId)
		);
		expect(request?.inputStorageId).toBe(firstStorage);
		expect(request?.filename).toBe('one.pdf');
	});

	it('rejects uploads over 50 MB and deletes the temporary blob', async () => {
		const t = initConvexTest();
		const run = await seedParseJob(t, { executionSecret: 'hosted-size-secret' });
		const created = await run.asUser.mutation(api.hostedParse.createUpload, {
			...auth(run),
			jobId: run.jobId
		});
		const storageId = await storeBlob(t, {
			bytes: 'x',
			type: 'application/pdf',
			size: 50_000_001
		});
		await run.asUser.mutation(api.hostedParse.start, {
			...auth(run),
			requestId: created.requestId,
			storageId,
			filename: 'huge.pdf'
		});
		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', storageId))).toBeNull();
		expect(
			await run.asUser.query(api.hostedParse.getResult, {
				runId: run.runId,
				executionSecret: run.executionSecret,
				requestId: created.requestId
			})
		).toEqual({
			status: 'failed',
			error: 'File exceeds the 50 MB hosted parse limit.'
		});
		const job = await t.run(async (ctx) => ctx.db.get('executorJobs', run.jobId));
		expect(job?.cloudWorkId).toBeUndefined();
	});

	it('requires the owning execution secret for getResult', async () => {
		const t = initConvexTest();
		const run = await seedParseJob(t, { executionSecret: 'hosted-result-auth-secret' });
		const created = await run.asUser.mutation(api.hostedParse.createUpload, {
			...auth(run),
			jobId: run.jobId
		});
		await expect(
			run.asUser.query(api.hostedParse.getResult, {
				runId: run.runId,
				executionSecret: 'wrong-secret',
				requestId: created.requestId
			})
		).rejects.toThrow('Run not found.');
	});

	it('stores a result URL and never writes billing or usage rows', async () => {
		const t = initConvexTest();
		const run = await seedParseJob(t, { executionSecret: 'hosted-success-secret' });
		const usageBefore = await t.run(async (ctx) => {
			return await ctx.db.query('threadUsageEvents').take(32);
		});
		const created = await run.asUser.mutation(api.hostedParse.createUpload, {
			...auth(run),
			jobId: run.jobId
		});
		const inputId = await storeBlob(t, { bytes: '%PDF-1.4', type: 'application/pdf' });
		await run.asUser.mutation(api.hostedParse.start, {
			...auth(run),
			requestId: created.requestId,
			storageId: inputId,
			filename: 'report.pdf'
		});
		const providerFetch = vi.fn(async (url: string, options?: RequestInit) => {
			if (url !== FIRECRAWL_PARSE_URL) return new Response('%PDF-1.4');
			expect(options?.method).toBe('POST');
			expect(options?.headers).toEqual({ Authorization: 'Bearer fc-test-key' });
			const form = options?.body;
			if (!(form instanceof FormData)) throw new Error('Expected multipart form');
			const file = form.get('file');
			if (!(file instanceof File)) throw new Error('Expected uploaded file');
			expect(file.name).toBe('report.pdf');
			expect(await file.text()).toBe('%PDF-1.4');
			const parseOptions = form.get('options');
			if (!(parseOptions instanceof Blob)) throw new Error('Expected JSON options');
			expect(JSON.parse(await parseOptions.text())).toEqual({
				formats: ['markdown'],
				parsers: [{ type: 'pdf', mode: 'auto' }],
				timeout: 300_000
			});
			return Response.json({ success: true, data: { markdown: '# Report' } });
		});
		vi.stubGlobal('fetch', providerFetch);
		const result = await t.action(internal.hostedParseActions.executeHostedParse, {
			requestId: created.requestId,
			jobId: run.jobId,
			runId: run.runId,
			claimId: run.claimId
		});
		const resultId = result.resultStorageId!;
		expect(resultId).toBeDefined();
		expect(providerFetch.mock.calls.filter(([url]) => url === FIRECRAWL_PARSE_URL)).toHaveLength(1);
		const stored = await t.run(async (ctx) => ctx.db.get('executorJobs', run.jobId));
		await t.mutation(internal.hostedParse.completeHostedParse, {
			workId: workId(stored),
			context: {
				requestId: created.requestId,
				jobId: run.jobId,
				runId: run.runId,
				claimId: run.claimId
			},
			result: { kind: 'success', returnValue: { resultStorageId: resultId } }
		});
		const completed = await run.asUser.query(api.hostedParse.getResult, {
			runId: run.runId,
			executionSecret: run.executionSecret,
			requestId: created.requestId
		});
		expect(completed.status).toBe('completed');
		expect(completed.url).toEqual(expect.any(String));
		await t.mutation(internal.hostedParse.completeHostedParse, {
			workId: workId(stored),
			context: {
				requestId: created.requestId,
				jobId: run.jobId,
				runId: run.runId,
				claimId: run.claimId
			},
			result: { kind: 'success', returnValue: { resultStorageId: resultId } }
		});
		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', inputId))).toBeNull();
		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', resultId))).not.toBeNull();
		const usageAfter = await t.run(async (ctx) => ctx.db.query('threadUsageEvents').take(32));
		expect(usageAfter).toEqual(usageBefore);
		const customers = await t.run(async (ctx) => ctx.db.query('billingCustomers').take(8));
		expect(customers).toEqual([]);
		const job = await t.run(async (ctx) => ctx.db.get('executorJobs', run.jobId));
		expect(job?.status).toBe('claimed');
	});

	it('rejects registered attachments and another parse input without deleting them', async () => {
		const t = initConvexTest();
		const run = await seedParseJob(t, { executionSecret: 'storage-owner' });
		const created = await t.mutation(api.hostedParse.createUpload, {
			...auth(run),
			jobId: run.jobId
		});
		const attachmentId = await storeBlob(t, { bytes: 'keep' });
		await t.run(async (ctx) => {
			await ctx.db.insert('imageUploads', {
				userId: run.subject,
				storageId: attachmentId,
				name: 'keep.pdf',
				mediaType: 'application/pdf',
				size: 4,
				attached: true
			});
		});
		await expect(
			t.mutation(api.hostedParse.start, {
				...auth(run),
				requestId: created.requestId,
				storageId: attachmentId,
				filename: ''
			})
		).rejects.toThrow('dedicated temporary upload');
		expect(await t.run((ctx) => ctx.db.system.get('_storage', attachmentId))).not.toBeNull();
		const other = await seedParseJob(t, { executionSecret: 'other-storage-owner' });
		const otherRequest = await t.mutation(api.hostedParse.createUpload, {
			...auth(other),
			jobId: other.jobId
		});
		const inputId = await storeBlob(t, { bytes: 'input' });
		await t.mutation(api.hostedParse.start, {
			...auth(other),
			requestId: otherRequest.requestId,
			storageId: inputId,
			filename: 'input.pdf'
		});
		await expect(
			t.mutation(api.hostedParse.start, {
				...auth(run),
				requestId: created.requestId,
				storageId: inputId,
				filename: 'input.pdf'
			})
		).rejects.toThrow('dedicated temporary upload');
		expect(
			await run.asUser.mutation(api.imageUploads.register, { storageId: inputId, name: '' })
		).toEqual({ error: 'Temporary parse files cannot be registered as attachments.' });
		expect(await t.run((ctx) => ctx.db.system.get('_storage', inputId))).not.toBeNull();
	});

	it.each(['new-claim', 'settled-job', 'skipped-result'])(
		'discards %s results without leaving pending requests',
		async (mode) => {
			const t = initConvexTest();
			const run = await seedParseJob(t, { executionSecret: `stale-${mode}` });
			const created = await t.mutation(api.hostedParse.createUpload, {
				...auth(run),
				jobId: run.jobId
			});
			const inputId = await storeBlob(t, { bytes: 'input' });
			await t.mutation(api.hostedParse.start, {
				...auth(run),
				requestId: created.requestId,
				storageId: inputId,
				filename: 'input.pdf'
			});
			const resultId =
				mode === 'skipped-result' ? undefined : await storeBlob(t, { bytes: 'late' });
			await t.run(async (ctx) => {
				if (mode === 'new-claim') await ctx.db.patch('runs', run.runId, { claimId: 'replacement' });
				if (mode === 'settled-job')
					await ctx.db.patch('executorJobs', run.jobId, { status: 'failed' });
			});
			const job = await t.run((ctx) => ctx.db.get('executorJobs', run.jobId));
			await t.mutation(internal.hostedParse.completeHostedParse, {
				workId: workId(job),
				context: {
					requestId: created.requestId,
					jobId: run.jobId,
					runId: run.runId,
					claimId: run.claimId
				},
				result: {
					kind: 'success',
					returnValue: resultId ? { resultStorageId: resultId } : { skipped: true }
				}
			});
			const request = await t.run((ctx) => ctx.db.get('hostedParseRequests', created.requestId));
			expect(request?.status).toBe('failed');
			expect(await t.run((ctx) => ctx.db.system.get('_storage', inputId))).toBeNull();
			if (resultId)
				expect(await t.run((ctx) => ctx.db.system.get('_storage', resultId))).toBeNull();
		}
	);

	it('records provider failures without retrying or billing', async () => {
		const t = initConvexTest();
		const run = await seedParseJob(t, { executionSecret: 'hosted-provider-error-secret' });
		const created = await run.asUser.mutation(api.hostedParse.createUpload, {
			...auth(run),
			jobId: run.jobId
		});
		const inputId = await storeBlob(t, { bytes: '%PDF', type: 'application/pdf' });
		await run.asUser.mutation(api.hostedParse.start, {
			...auth(run),
			requestId: created.requestId,
			storageId: inputId,
			filename: 'broken.pdf'
		});
		const stored = await t.run(async (ctx) => ctx.db.get('executorJobs', run.jobId));
		await t.mutation(internal.hostedParse.completeHostedParse, {
			workId: workId(stored),
			context: {
				requestId: created.requestId,
				jobId: run.jobId,
				runId: run.runId,
				claimId: run.claimId
			},
			result: { kind: 'failed', error: 'Firecrawl parse failed (500).' }
		});
		expect(
			await run.asUser.query(api.hostedParse.getResult, {
				runId: run.runId,
				executionSecret: run.executionSecret,
				requestId: created.requestId
			})
		).toEqual({
			status: 'failed',
			error: 'Firecrawl parse failed (500).'
		});
		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', inputId))).toBeNull();
		const job = await t.run(async (ctx) => ctx.db.get('executorJobs', run.jobId));
		expect(job?.status).toBe('claimed');
		expect(await t.run(async (ctx) => ctx.db.query('threadUsageEvents').take(8))).toEqual([]);
	});

	it('deletes late results from cancelled callbacks and does not complete the job', async () => {
		const t = initConvexTest();
		const run = await seedParseJob(t, { executionSecret: 'hosted-cancel-secret' });
		const created = await run.asUser.mutation(api.hostedParse.createUpload, {
			...auth(run),
			jobId: run.jobId
		});
		const inputId = await storeBlob(t, { bytes: '%PDF', type: 'application/pdf' });
		await run.asUser.mutation(api.hostedParse.start, {
			...auth(run),
			requestId: created.requestId,
			storageId: inputId,
			filename: 'late.pdf'
		});
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', run.runId, { cancellationRequestedAt: Date.now() });
			await ctx.db.patch('executorJobs', run.jobId, { status: 'cancelled' });
		});
		const resultId = await storeBlob(t, { bytes: '# Late', type: 'text/markdown' });
		const stored = await t.run(async (ctx) => ctx.db.get('executorJobs', run.jobId));
		await t.mutation(internal.hostedParse.completeHostedParse, {
			workId: workId(stored),
			context: {
				requestId: created.requestId,
				jobId: run.jobId,
				runId: run.runId,
				claimId: run.claimId
			},
			result: { kind: 'success', returnValue: { resultStorageId: resultId } }
		});
		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', resultId))).toBeNull();
		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', inputId))).toBeNull();
		expect(
			await run.asUser.query(api.hostedParse.getResult, {
				runId: run.runId,
				executionSecret: run.executionSecret,
				requestId: created.requestId
			})
		).toEqual({ status: 'failed', error: 'Parse was cancelled.' });
		const job = await t.run(async (ctx) => ctx.db.get('executorJobs', run.jobId));
		expect(job?.status).toBe('cancelled');
		expect(job?.result).toBeUndefined();
	});

	it('expires temporary parse blobs without deleting user attachments', async () => {
		const t = initConvexTest();
		const run = await seedParseJob(t, { executionSecret: 'hosted-ttl-secret' });
		const created = await run.asUser.mutation(api.hostedParse.createUpload, {
			...auth(run),
			jobId: run.jobId
		});
		const inputId = await storeBlob(t, { bytes: '%PDF', type: 'application/pdf' });
		await run.asUser.mutation(api.hostedParse.start, {
			...auth(run),
			requestId: created.requestId,
			storageId: inputId,
			filename: 'ttl.pdf'
		});
		const resultId = await storeBlob(t, { bytes: '# Kept attachment', type: 'text/markdown' });
		const attachmentId = await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(['user-bytes']));
			await ctx.db.insert('imageUploads', {
				userId: run.subject,
				storageId,
				name: 'photo.png',
				mediaType: 'image/png',
				size: 10,
				attached: true
			});
			return storageId;
		});
		const stored = await t.run(async (ctx) => ctx.db.get('executorJobs', run.jobId));
		await t.mutation(internal.hostedParse.completeHostedParse, {
			workId: workId(stored),
			context: {
				requestId: created.requestId,
				jobId: run.jobId,
				runId: run.runId,
				claimId: run.claimId
			},
			result: { kind: 'success', returnValue: { resultStorageId: resultId } }
		});
		await t.run(async (ctx) => {
			await ctx.db.patch('hostedParseRequests', created.requestId, { expiresAt: Date.now() - 1 });
		});
		expect(await t.mutation(internal.hostedParse.cleanupExpired, {})).toBe(1);
		expect(
			await t.run(async (ctx) => ctx.db.get('hostedParseRequests', created.requestId))
		).toBeNull();
		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', resultId))).toBeNull();
		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', attachmentId))).not.toBeNull();
	});
});
