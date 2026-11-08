/// <reference types="vite/client" />

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import migrationsTest from '@convex-dev/migrations/test';
import exaTest from '@exalabs/convex-exa/test';
import workpoolTest from '@convex-dev/workpool/test';
import posthogTest from '@posthog/convex/test';
import { vWorkId, type WorkId } from '@convex-dev/workpool';
import { ContextDev } from 'context.dev';
import { APIPromise } from 'context.dev/core/api-promise';
import { Web, type WebScrapeParams, type WebScrapeResponse } from 'context.dev/resources/web';
import { parse } from 'convex-helpers/validators';
import { convexTest, type TestConvex } from 'convex-test';
import { vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import type { FunctionArgs } from 'convex/server';
import type { CompletionProvider } from '@convex/lib/validators';
import { abandonRunRecord } from '@convex/lib/runFinalize';
import { getRunWithExecution } from '@convex/lib/runExecution';
import { MODEL_USAGE_UNITS_PER_DOLLAR } from '@convex/lib/tiers';
import schema from './schema';

export const modules = import.meta.glob([
	'./**/*.ts',
	'./**/*.js',
	'!./**/*.test.ts',
	'!./**/*.config.ts',
	'!./**/*.d.ts',
	'!./**/*test.setup.ts'
]);

export type ConvexTestInstance = TestConvex<typeof schema>;

/**
 * convex-test starts each transaction at or after the last commit, so once two
 * commits share a frozen fake millisecond, functions see Date.now() 1ms ahead.
 * Call this before a transaction whose timestamps the test asserts exactly.
 */
export function tickPastLastCommit() {
	vi.setSystemTime(Date.now() + 1);
}

/** Runs scheduled functions until none are due, allowing for the lead described at `tickPastLastCommit`. */
export async function finishDueScheduledFunctions(t: ConvexTestInstance) {
	for (let iteration = 0; iteration < 1000; iteration++) {
		const pending = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());

		if (
			!pending.some(
				(entry) => entry.state.kind === 'pending' && entry.scheduledTime <= Date.now() + 1
			)
		)
			return;
		await vi.advanceTimersByTimeAsync(1);
		await t.finishInProgressScheduledFunctions();
	}

	throw new Error('Due scheduled functions did not settle.');
}

export function fixtureWorkId(value: string): WorkId {
	return parse(vWorkId, value);
}

const emptyScrapeOutput = { data: null, requested: false, success: null };

export function contextDevScrapeResponse(
	overrides: Partial<WebScrapeResponse> = {}
): WebScrapeResponse {
	return {
		bytes: emptyScrapeOutput,
		cache_metadata: { age_ms: 0, status: 'miss' },
		highlights: emptyScrapeOutput,
		html: emptyScrapeOutput,
		images: emptyScrapeOutput,
		json: emptyScrapeOutput,
		markdown: { data: '# Page', requested: true, success: true },
		metadata: { title: 'Page', headings: [{ level: 1, text: 'Page' }] },
		parsed: { ...emptyScrapeOutput, type: 'custom' },
		product: emptyScrapeOutput,
		profile: null,
		request_id: 'request-1',
		screenshot: emptyScrapeOutput,
		url: 'https://example.com/page',
		...overrides
	};
}

function apiPromise<T>(result: Promise<T>): APIPromise<T> {
	const props = result.then(() => ({
		response: new Response(),
		options: { method: 'post' as const, path: '/web/scrape' },
		controller: new AbortController(),
		requestLogID: 'test',
		retryOfRequestLogID: undefined,
		startTime: 0
	}));

	return new APIPromise(new ContextDev({ apiKey: 'test' }), props, () => result);
}

export function mockContextDevScrape(
	scrape: (
		body: WebScrapeParams,
		options?: Parameters<Web['scrape']>[1]
	) => Promise<WebScrapeResponse>
) {
	return vi
		.spyOn(Web.prototype, 'scrape')
		.mockImplementation((body, options) => apiPromise(scrape(body, options)));
}

export function insertUser(ctx: MutationCtx, subject: string, dodoCustomerId?: string) {
	return ctx.db.insert('users', {
		subject,
		tokenIdentifier: subject,
		email: `${subject}@example.com`,
		dodoCustomerId
	});
}

const DODO_WEBHOOK_SECRET = 'test_webhook_secret';

export function stubDodoEnv() {
	vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
	vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
	vi.stubEnv(
		'DODO_PAYMENTS_WEBHOOK_SECRET',
		`whsec_${Buffer.from(DODO_WEBHOOK_SECRET).toString('base64url')}`
	);
}

/** Posts a webhook signed with the secret `stubDodoEnv` configures. */
export async function sendDodoWebhook<Data>(
	t: ConvexTestInstance,
	type: string,
	data: Data,
	{ tamper = false } = {}
) {
	const body = JSON.stringify({ business_id: 'business', type, timestamp: new Date(), data });
	const webhookId = `webhook_${crypto.randomUUID()}`;
	const timestamp = String(Math.floor(Date.now() / 1_000));
	const encoder = new TextEncoder();

	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(DODO_WEBHOOK_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		encoder.encode(`${webhookId}.${timestamp}.${body}`)
	);

	return await t.fetch('/dodopayments-webhook', {
		method: 'POST',
		body,
		headers: {
			'webhook-id': webhookId,
			'webhook-timestamp': timestamp,
			'webhook-signature': tamper
				? 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
				: `v1,${Buffer.from(signature).toString('base64')}`
		}
	});
}

export async function seedTiers(t: ConvexTestInstance): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('tiers', {
			tierId: 'free',
			label: 'Free',
			monthly: 15 * MODEL_USAGE_UNITS_PER_DOLLAR
		});
		await ctx.db.insert('tiers', {
			tierId: 'pro',
			label: 'Pro',
			monthlyProductId: 'prod_pro',
			annualProductId: 'prod_pro_annual',
			monthly: 75 * MODEL_USAGE_UNITS_PER_DOLLAR
		});
		await ctx.db.insert('tiers', {
			tierId: 'max',
			label: 'Max',
			monthlyProductId: 'prod_max',
			monthly: 500 * MODEL_USAGE_UNITS_PER_DOLLAR
		});
	});
}

type AuthenticatedTest = ReturnType<ConvexTestInstance['withIdentity']>;

export function toolTranscriptAssignment(
	runId: Id<'runs'>,
	claimId: string,
	sectionOrdinal = 1,
	attemptSeq = 0,
	streamId = `test-stream-${sectionOrdinal}`
) {
	return {
		attemptSeq,
		streamId,
		sectionOrdinal,
		toolInvocationId: `test-invocation-${sectionOrdinal}`,
		sectionKey: `agent:${runId}:${claimId}:${attemptSeq}:section:${sectionOrdinal}`
	};
}

export const emptyCompletionAssignments = {
	work: { ranges: [] },
	toolInvocations: [],
	sections: []
};

export function initConvexTest(): ConvexTestInstance {
	const t = convexTest({ schema, modules, transactionLimits: true });
	rateLimiterTest.register(t);
	migrationsTest.register(t);
	exaTest.register(t);
	workpoolTest.register(t, 'webSearchWorkpool');
	workpoolTest.register(t, 'contextDevWorkpool');
	workpoolTest.register(t, 'firecrawlScrapeWorkpool');
	posthogTest.register(t);

	return t;
}

export async function seedOwnedThread(
	t: ConvexTestInstance,
	subject = 'user_alice'
): Promise<{
	asUser: AuthenticatedTest;
	subject: string;
	repositoryKey: string;
	threadId: Id<'threadRecords'>;
}> {
	const asUser = t.withIdentity({ subject });
	const repositoryKey = 'alpha';
	const threadId = await seedThreadRecord(t, subject, repositoryKey);

	return {
		asUser,
		subject,
		repositoryKey,
		threadId
	};
}

export async function readTranscriptRange(
	asUser: AuthenticatedTest,
	threadId: Id<'threadRecords'>,
	start: number,
	end: number
) {
	return await asUser.query(api.transcript.getPartsPage, { threadId, start, end, order: 'asc' });
}

export async function seedThreadRecord(
	t: ConvexTestInstance,
	userId: string,
	repositoryKey: string
): Promise<Id<'threadRecords'>> {
	return await t.run(async (ctx) => {
		const submissionId = `thread-${userId}-${Date.now()}-${Math.random()}`;

		const threadId = await ctx.db.insert('threadRecords', {
			userId,
			status: 'completed',
			repositoryKey,
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			fastMode: false,
			lastMessageAt: Date.now()
		});

		const runId = await ctx.db.insert('runs', {
			threadId,
			userId,
			submissionId,
			status: 'completed',
			executionSecretHash: 'fixture',
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			fastMode: false,
			completedAt: Date.now()
		});

		await ctx.db.insert('runExecutionStates', {
			runId,
			completionAttemptSeq: 0,
			terminalJobsReconciled: true
		});

		return threadId;
	});
}

export async function abandonRun(t: ConvexTestInstance, runId: Id<'runs'>) {
	await t.run(async (ctx) => {
		await abandonRunRecord(ctx, (await getRunWithExecution(ctx.db, runId))!);
	});
}

export async function insertQueuedRun(
	t: ConvexTestInstance,
	asUser: AuthenticatedTest,
	args: {
		threadId: Id<'threadRecords'>;
		submissionId: string;
		executionSecret: string;
		prompt: string;
		imageUploadIds?: Id<'imageUploads'>[];
		selectedModel?: string;
		completionProvider?: CompletionProvider;
		reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
		fastMode?: boolean;
		machineId?: string;
		continuationOfRunId?: Id<'runs'>;
		automaticRecovery?: boolean;
		deferPrompt?: boolean;
	}
) {
	const thread = await asUser.query(api.threads.getByThreadId, { threadId: args.threadId });

	const request: FunctionArgs<typeof internal.agentRuntime.insertGatewayRun> = {
		userId: thread.userId,
		submissionId: args.submissionId,
		threadId: args.threadId,
		prompt: args.prompt,
		imageUploadIds: args.imageUploadIds ?? [],
		selectedModel: args.selectedModel ?? 'gpt-5.6-sol',
		completionProvider: args.completionProvider ?? 'spikonado',
		reasoningEffort: args.reasoningEffort ?? 'medium',
		fastMode: args.fastMode ?? false,
		executionSecret: args.executionSecret,
		machineId: args.machineId
	};

	if (args.continuationOfRunId) request.continuationOfRunId = args.continuationOfRunId;

	if (args.automaticRecovery) request.automaticRecovery = true;

	if (args.deferPrompt) request.deferPrompt = true;

	return await t.mutation(internal.agentRuntime.insertGatewayRun, request);
}

export async function createQueuedRun(
	t: ConvexTestInstance,
	asUser: AuthenticatedTest,
	threadId: Id<'threadRecords'>,
	submissionId: string,
	executionSecret: string,
	prompt = 'Do the thing'
) {
	return await insertQueuedRun(t, asUser, {
		threadId,
		submissionId,
		executionSecret,
		prompt
	});
}

export async function seedStartedWebJob(
	t: ConvexTestInstance,
	options: {
		executionSecret: string;
		kind: 'web_search' | 'scrape_url' | 'lookup_parts';
		payload: { query: string } | { url: string } | { parts: string[]; quantity?: number };
		prompt?: string;
		claimId?: string;
	}
) {
	const { asUser, threadId } = await seedOwnedThread(t);
	const claimId = options.claimId ?? 'claim-a';

	const created = await createQueuedRun(
		t,
		asUser,
		threadId,
		options.executionSecret,
		options.executionSecret,
		options.prompt ?? 'Search'
	);

	await asUser.mutation(api.agentRuntime.start, {
		runId: created.runId,
		claimId,
		executionSecret: options.executionSecret
	});

	const job = await asUser.mutation(api.agentRuntime.beginToolJob, {
		runId: created.runId,
		claimId,
		...toolTranscriptAssignment(created.runId, claimId),
		kind: options.kind,
		payload: options.payload,
		executionSecret: options.executionSecret
	});

	return {
		asUser,
		runId: created.runId,
		claimId,
		jobId: job.jobId,
		executionSecret: options.executionSecret
	};
}
