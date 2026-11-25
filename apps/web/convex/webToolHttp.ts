import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { httpAction, internalQuery, type ActionCtx } from '@convex/_generated/server';
import { RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';
import { getExecutionRunRecord } from '@convex/lib/auth';
import { claimedJobForActiveRun } from '@convex/lib/claimedWebJob';
import { requestContextDevScrape } from '@convex/lib/contextDev';
import {
	PARSE_MAX_INPUT_BYTES,
	parseUploadFilename,
	requestFirecrawlParse
} from '@convex/lib/firecrawl';

export const activeJob = internalQuery({
	args: {
		runId: v.string(),
		claimId: v.string(),
		jobId: v.string(),
		executionSecret: v.string()
	},
	returns: v.union(
		v.null(),
		v.object({
			kind: v.union(v.literal('parse_file'), v.literal('scrape_url')),
			url: v.optional(v.string())
		})
	),
	handler: async (ctx, args) => {
		const runId = ctx.db.normalizeId('runs', args.runId);
		const jobId = ctx.db.normalizeId('executorJobs', args.jobId);

		if (!runId || !jobId) return null;

		try {
			await getExecutionRunRecord(ctx, runId, args.executionSecret);
		} catch {
			return null;
		}

		const active = await claimedJobForActiveRun(ctx, { runId, jobId, claimId: args.claimId });
		const job = active?.job;

		if (job?.status !== 'claimed') return null;

		if (job.kind === 'parse_file') return { kind: job.kind };

		if (job.kind === 'scrape_url' && 'url' in job.payload) {
			return { kind: job.kind, url: job.payload.url };
		}

		return null;
	}
});

async function requestedJob(ctx: ActionCtx, request: Request) {
	const params = new URL(request.url).searchParams;
	const executionSecret = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];

	if (!executionSecret) return null;

	return await ctx.runQuery(internal.webToolHttp.activeJob, {
		runId: params.get('runId') ?? '',
		claimId: params.get('claimId') ?? '',
		jobId: params.get('jobId') ?? '',
		executionSecret
	});
}

function failure(status: number, message: string): Response {
	return new Response(message, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
}

async function streamedProviderResponse(request: () => Promise<Response>): Promise<Response> {
	try {
		const response = await request();

		return new Response(response.body, { headers: { 'content-type': 'application/json' } });
	} catch (error) {
		return failure(502, error instanceof Error ? error.message : 'The provider request failed.');
	}
}

export const scrape = httpAction(async (ctx, request) => {
	const job = await requestedJob(ctx, request);

	if (job?.kind !== 'scrape_url' || !job.url) return failure(409, RUN_NO_LONGER_ACTIVE);
	const url = job.url;
	const rawDocument = new URL(request.url).searchParams.get('rawDocument') === 'true';

	return await streamedProviderResponse(() =>
		requestContextDevScrape(
			url,
			rawDocument,
			async () => (await requestedJob(ctx, request)) !== null
		)
	);
});

export const parse = httpAction(async (ctx, request) => {
	if (!(await requestedJob(ctx, request))) return failure(409, RUN_NO_LONGER_ACTIVE);
	const size = Number(request.headers.get('content-length'));

	if (!request.body || !Number.isSafeInteger(size) || size <= 0 || size > PARSE_MAX_INPUT_BYTES) {
		return failure(413, 'Firecrawl accepts files up to 50 MB.');
	}

	const params = new URL(request.url).searchParams;
	const filename = parseUploadFilename(params.get('filename') ?? '');

	if (!filename) return failure(400, 'Filename must be between 1 and 255 characters.');

	const body = request.body;

	return await streamedProviderResponse(() =>
		requestFirecrawlParse({ body, size, filename, pages: params.get('pages') === 'true' })
	);
});
