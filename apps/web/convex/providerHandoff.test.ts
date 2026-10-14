import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { appendTranscriptPart } from '@convex/lib/transcriptParts';
import { patchRunExecution } from '@convex/lib/runExecution';
import {
	initConvexTest,
	insertQueuedRun,
	seedOwnedThread,
	type ConvexTestInstance
} from './test.setup';

type Provider = NonNullable<Doc<'runs'>['completionProvider']>;

async function historicalRun(
	t: ConvexTestInstance,
	threadId: Id<'threadRecords'>,
	completionProvider: Provider | undefined,
	completion: 'nonempty' | 'empty' | 'none' = 'nonempty'
) {
	return await t.run(async (ctx) => {
		const runId = await ctx.db.insert('runs', {
			threadId,
			userId: 'user_alice',
			submissionId: crypto.randomUUID(),
			status: 'failed',
			executionSecretHash: 'fixture',
			completionProvider,
			selectedModel: 'old-model',
			reasoningEffort: 'high',
			fastMode: true,
			startedAt: Date.now()
		});

		await ctx.db.insert('runExecutionStates', { runId, completionAttemptSeq: 0 });

		if (completion !== 'none') {
			await appendTranscriptPart(ctx, {
				threadId,
				userId: 'user_alice',
				runId,
				kind: 'completion',
				sourceKey: `completion:${runId}`,
				completion: {
					items:
						completion === 'empty'
							? []
							: [
									{
										type: 'reasoning',
										id: 'reasoning',
										text: '',
										providerMetadata: { encrypted: 'old-provider-data' }
									}
								]
				},
				work: { ranges: [] }
			});
		}

		return runId;
	});
}

async function currentRun(
	t: ConvexTestInstance,
	threadId: Id<'threadRecords'>,
	completionProvider: Provider
) {
	const asUser = t.withIdentity({ subject: 'user_alice' });

	const created = await insertQueuedRun(t, asUser, {
		threadId,
		submissionId: crypto.randomUUID(),
		completionProvider,
		selectedModel: 'new-model',
		reasoningEffort: 'low',
		fastMode: false,
		prompt: 'Continue on the new provider',
		executionSecret: 'secret'
	});

	return { runId: created.runId, executionSecret: 'secret' };
}

const providers: Provider[] = ['spikonado', 'openai', 'chatgpt'];

const switches = providers.flatMap((source) =>
	providers.flatMap((target) => (source !== target ? [{ source, target }] : []))
);

describe('provider handoff provenance', () => {
	it.each(switches)(
		'uses the completion run settings for $source to $target',
		async ({ source, target }) => {
			const t = initConvexTest();
			const { threadId } = await seedOwnedThread(t);
			await historicalRun(t, threadId, source);
			await historicalRun(t, threadId, target, 'none');
			await historicalRun(t, threadId, target, 'empty');
			const run = await currentRun(t, threadId, target);
			const context = await t.query(api.agentRuntime.getContext, run);

			expect(context.providerHandoff).toEqual({
				completionProvider: source,
				selectedModel: 'old-model',
				reasoningEffort: 'high',
				fastMode: true
			});
			expect(context.run).toMatchObject({
				completionProvider: target,
				selectedModel: 'new-model',
				reasoningEffort: 'low',
				fastMode: false
			});
		}
	);

	it('defaults missing historical provider to Spikonado without execution state', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		const historicalRunId = await historicalRun(t, threadId, undefined);
		const run = await currentRun(t, threadId, 'chatgpt');
		await t.run(async (ctx) => {
			const state = await ctx.db
				.query('runExecutionStates')
				.withIndex('by_runId', (query) => query.eq('runId', historicalRunId))
				.unique();

			if (state) await ctx.db.delete('runExecutionStates', state._id);
		});

		expect(
			(await t.query(api.agentRuntime.getContext, run)).providerHandoff?.completionProvider
		).toBe('spikonado');
	});

	it.each(providers)(
		'returns model changes on %s for catalog vendor comparison',
		async (provider) => {
			const t = initConvexTest();
			const { threadId } = await seedOwnedThread(t);
			await historicalRun(t, threadId, provider === 'openai' ? 'chatgpt' : 'openai');
			await historicalRun(t, threadId, provider);
			const run = await currentRun(t, threadId, provider);

			expect((await t.query(api.agentRuntime.getContext, run)).providerHandoff).toEqual({
				completionProvider: provider,
				selectedModel: 'old-model',
				reasoningEffort: 'high',
				fastMode: true
			});
			await t.run(async (ctx) => {
				await ctx.db.patch('runs', run.runId, { selectedModel: 'old-model' });
			});
			expect(await t.query(api.agentRuntime.getContext, run)).not.toHaveProperty('providerHandoff');
		}
	);

	it('does not hand off empty histories', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		await historicalRun(t, threadId, 'openai', 'none');
		await historicalRun(t, threadId, 'chatgpt', 'empty');
		const run = await currentRun(t, threadId, 'spikonado');

		expect(await t.query(api.agentRuntime.getContext, run)).not.toHaveProperty('providerHandoff');
	});

	it('ignores current-run completions and completions covered by a handoff', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		await historicalRun(t, threadId, 'openai');
		const run = await currentRun(t, threadId, 'chatgpt');
		await t.run(async (ctx) => {
			await appendTranscriptPart(ctx, {
				threadId,
				userId: 'user_alice',
				runId: run.runId,
				kind: 'completion',
				sourceKey: 'current',
				completion: { items: [{ type: 'text', id: 'current', text: 'Current completion' }] },
				work: { ranges: [] }
			});
		});

		expect(
			(await t.query(api.agentRuntime.getContext, run)).providerHandoff?.completionProvider
		).toBe('openai');
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', threadId, {
				contextSummary: 'Old work summarized',
				contextSummaryThroughPartNumber: 0
			});
		});
		expect(await t.query(api.agentRuntime.getContext, run)).not.toHaveProperty('providerHandoff');
	});
});

describe('provider handoff credential authorization', () => {
	afterEach(() => vi.unstubAllEnvs());

	it.each([
		{ source: 'spikonado', target: 'openai' },
		{ source: 'openai', target: 'spikonado' }
	] as const)(
		'authorizes $source only until the handoff is saved, keeps $target authorized',
		async ({ source, target }) => {
			vi.stubEnv('MODEL_GATEWAY_TOKEN_SECRET', 'gateway-test-secret');
			const t = initConvexTest();
			const { threadId } = await seedOwnedThread(t);
			await historicalRun(t, threadId, source);
			const run = await currentRun(t, threadId, target);
			const args = { ...run, claimId: 'claim' };
			await t.mutation(api.agentRuntime.start, args);

			const authorize = (provider: Provider, credentials = args) =>
				provider === 'spikonado'
					? t.mutation(api.agentRuntime.issueGatewayCredential, credentials)
					: t.query(internal.providerCredentials.authorizeOpenAiCredential, credentials);

			await expect(authorize(source)).resolves.toBeDefined();
			await expect(authorize(target)).resolves.toBeDefined();
			await expect(authorize(source, { ...args, claimId: 'stale' })).rejects.toThrow(
				'Run is no longer active.'
			);
			await expect(authorize(source, { ...args, executionSecret: 'wrong' })).rejects.toThrow(
				'Run not found.'
			);
			await t.run(async (ctx) => {
				await ctx.db.patch('runs', run.runId, { cancellationRequestedAt: Date.now() });
			});
			await expect(authorize(source)).rejects.toThrow('Run is no longer active.');
			await t.run(async (ctx) => {
				await ctx.db.patch('runs', run.runId, { cancellationRequestedAt: undefined });
			});
			await t.mutation(api.agentRuntime.registerCompletionAttempt, { ...args, attemptSeq: 1 });
			await expect(
				t.mutation(api.agentRuntime.saveContextHandoff, {
					...args,
					completionAttemptSeq: 1,
					beforePrompt: true,
					summary: 'Old provider summary'
				})
			).resolves.toBe(true);
			expect(await t.query(api.agentRuntime.getContext, run)).not.toHaveProperty('providerHandoff');
			await expect(authorize(source)).rejects.toThrow('Run is not configured');
			await expect(authorize(target)).resolves.toBeDefined();
			await t.run(async (ctx) => {
				await patchRunExecution(ctx, run.runId, { claimExpiresAt: Date.now() - 1 });
			});
			await expect(authorize(target)).rejects.toThrow('Run is no longer active.');
		}
	);
});
