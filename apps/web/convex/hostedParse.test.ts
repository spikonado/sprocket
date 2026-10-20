/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patchRunExecution } from '@convex/lib/runExecution';
import type { WorkId } from '@convex-dev/workpool';
import type { GenericDatabaseWriter, GenericDataModel, SystemDataModel } from 'convex/server';
import { api, internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { Firecrawl, SdkError } from 'firecrawl';
import {
	HOSTED_PARSE_MAX_OUTPUT_BYTES,
	parseFirecrawlParseDocument
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
		kind?: 'parse_file' | 'scrape_url' | 'web_search';
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
			toolInvocationId: `test-invocation-hosted-parse-${Math.random()}`,
			payload:
				options.kind === 'web_search'
					? { query: 'sprocket' }
					: options.kind === 'scrape_url'
						? { url: 'https://example.com/doc.pdf' }
						: { path: '/tmp/doc.pdf' },
			hidden: false,
			status: 'claimed',
			enqueuedAt: Date.now(),
			claimedAt: Date.now(),
			sequence: 0
		});

		await patchRunExecution(ctx, created.runId, {
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
			await db.patch('_storage', storageId, metadata);
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

describe('Firecrawl parse document contract', () => {
	it('requires markdown and rejects truncated PDFs', () => {
		expect(
			parseFirecrawlParseDocument({
				markdown: '# Report',
				metadata: { numPages: 2, totalPages: 2 }
			})
		).toEqual({ markdown: '# Report' });
		expect(
			parseFirecrawlParseDocument({
				markdown: '# Partial',
				metadata: { numPages: 2, totalPages: 10 }
			})
		).toEqual({ error: 'Parsed document was truncated.' });
		expect(parseFirecrawlParseDocument({})).toEqual({
			error: 'Firecrawl parse did not return markdown.'
		});
	});

	it('rejects oversized provider payloads', () => {
		expect(
			parseFirecrawlParseDocument({ markdown: 'x'.repeat(HOSTED_PARSE_MAX_OUTPUT_BYTES + 1) })
		).toEqual({ error: 'Firecrawl parse response is too large.' });
		expect(
			parseFirecrawlParseDocument(
				{ pages: [{ pageNumber: 1, markdown: 'x'.repeat(HOSTED_PARSE_MAX_OUTPUT_BYTES + 1) }] },
				true
			)
		).toEqual({ error: 'Firecrawl parse response is too large.' });
		// JSON escaping doubles each quote, so only the stored file exceeds the limit.
		const quotes = '"'.repeat(HOSTED_PARSE_MAX_OUTPUT_BYTES / 2 + 1);
		expect(
			parseFirecrawlParseDocument({ pages: [{ pageNumber: 1, markdown: quotes }] }, true)
		).toEqual({ error: 'Firecrawl parse response is too large.' });
	});

	it('reads per-page markdown only when pages are requested', () => {
		const pages = [
			{ pageNumber: 1, markdown: '# One' },
			{ pageNumber: 2, markdown: '' }
		];

		expect(parseFirecrawlParseDocument({ markdown: '# One', pages }, true)).toEqual({ pages });
		expect(parseFirecrawlParseDocument({ markdown: '# One' }, true)).toEqual({
			error: 'Firecrawl parse did not return pages.'
		});
		// SAFETY: The API sends null for absent pages even though the SDK types say optional.
		const withoutPages = { markdown: '# One', pages: null } as never;
		expect(parseFirecrawlParseDocument(withoutPages)).toEqual({ markdown: '# One' });
	});
});

describe('hostedParse', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv('FIRECRAWL_API_KEY', 'fc-test-key');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it('gates createUpload on a configured server API key', async () => {
		vi.stubEnv('FIRECRAWL_API_KEY', undefined);
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

	it('cancels queued parsing in the scrape pool rather than the Exa pool', async () => {
		const t = initConvexTest();
		const run = await seedParseJob(t, { executionSecret: 'hosted-pool-cancel' });

		const created = await run.asUser.mutation(api.hostedParse.createUpload, {
			...auth(run),
			jobId: run.jobId
		});

		const storageId = await storeBlob(t, { bytes: 'pdf', type: 'application/pdf' });
		await run.asUser.mutation(api.hostedParse.start, {
			...auth(run),
			requestId: created.requestId,
			storageId,
			filename: 'file.pdf'
		});
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		await run.asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: run.runId,
			executionSecret: run.executionSecret,
			text: '',
			status: 'cancelled'
		});
		await vi.advanceTimersByTimeAsync(1_000);
		await t.finishInProgressScheduledFunctions();
		expect(fetch).not.toHaveBeenCalled();
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

	it.each(['parse_file', 'scrape_url'] as const)(
		'stores a %s result URL and never writes billing or usage rows',
		async (kind) => {
			const t = initConvexTest();
			const run = await seedParseJob(t, { executionSecret: 'hosted-success-secret', kind });

			const usageBefore = await t.run(async (ctx) => {
				return await ctx.db.query('modelCallUsage').take(32);
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

			vi.stubGlobal(
				'fetch',
				vi.fn(async () => new Response('%PDF-1.4'))
			);

			const parse = vi
				.spyOn(Firecrawl.prototype, 'parse')
				.mockResolvedValue({ markdown: '# Report' });

			const result = await t.action(internal.hostedParseActions.executeHostedParse, {
				requestId: created.requestId,
				jobId: run.jobId,
				runId: run.runId,
				claimId: run.claimId
			});

			const resultId = result.resultStorageId!;
			expect(resultId).toBeDefined();
			expect(parse).toHaveBeenCalledTimes(1);

			const [file, options] = parse.mock.calls[0]!;
			expect(file).toMatchObject({ filename: 'report.pdf', contentType: 'application/pdf' });
			// SAFETY: executeHostedParse uploads the stored bytes as a Uint8Array.
			const uploaded = file.data as Uint8Array;
			expect(new TextDecoder().decode(uploaded)).toBe('%PDF-1.4');
			expect(options).toMatchObject({
				formats: ['markdown'],
				parsers: [{ type: 'pdf', mode: 'auto' }]
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
			const usageAfter = await t.run(async (ctx) => ctx.db.query('modelCallUsage').take(32));
			expect(usageAfter).toEqual(usageBefore);
			const job = await t.run(async (ctx) => ctx.db.get('executorJobs', run.jobId));
			expect(job?.status).toBe('claimed');
		}
	);

	it('stores per-page OCR results as JSON when pages are requested', async () => {
		const t = initConvexTest();

		const run = await seedParseJob(t, {
			executionSecret: 'hosted-pages-secret',
			kind: 'scrape_url'
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
			filename: 'scanned-pages.pdf',
			pages: true
		});

		const pages = [
			{ pageNumber: 2, markdown: '# Two' },
			{ pageNumber: 1, markdown: '# One' }
		];

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('%PDF-1.4'))
		);

		// SAFETY: The parse result is only read for `markdown` and the page fields set here.
		const parsed = { markdown: '# Two\n\n# One', pages } as never;
		const parse = vi.spyOn(Firecrawl.prototype, 'parse').mockResolvedValue(parsed);

		const result = await t.action(internal.hostedParseActions.executeHostedParse, {
			requestId: created.requestId,
			jobId: run.jobId,
			runId: run.runId,
			claimId: run.claimId
		});

		expect(parse.mock.calls[0]?.[1]).toMatchObject({
			parsers: [{ type: 'pdf', mode: 'auto', pages: true }]
		});

		const stored = await t.run(async (ctx) => {
			const blob = await ctx.storage.get(result.resultStorageId!);

			return blob ? { type: blob.type, text: await blob.text() } : null;
		});

		expect(stored?.type).toBe('application/json');
		expect(JSON.parse(stored?.text ?? '')).toEqual({ pages });
	});

	it('reports exhausted Firecrawl credits', async () => {
		const t = initConvexTest();
		const run = await seedParseJob(t, { executionSecret: 'hosted-credits-secret' });

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
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('%PDF-1.4'))
		);
		vi.spyOn(Firecrawl.prototype, 'parse').mockRejectedValue(new SdkError('Payment required', 402));

		await expect(
			t.action(internal.hostedParseActions.executeHostedParse, {
				requestId: created.requestId,
				jobId: run.jobId,
				runId: run.runId,
				claimId: run.claimId
			})
		).rejects.toThrow('Firecrawl credits are exhausted.');
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
			await run.asUser.mutation(api.imageUploads.registerFile, { storageId: inputId, name: '' })
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
				if (mode === 'new-claim')
					await patchRunExecution(ctx, run.runId, { claimId: 'replacement' });

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
		expect(await t.run(async (ctx) => ctx.db.query('modelCallUsage').take(8))).toEqual([]);
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
