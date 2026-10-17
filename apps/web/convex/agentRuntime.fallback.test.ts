import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest, insertQueuedRun, seedOwnedThread } from './test.setup';

describe('provider fallback', () => {
	it('moves a run along its provider chain and drops reasoning replay', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'fallback-secret';

		const { runId } = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'fallback-run',
			executionSecret,
			prompt: 'Use the first provider that works',
			completionProvider: 'chatgpt',
			fallbackProviders: ['openai', 'spikonado']
		});

		await asUser.mutation(api.agentRuntime.start, { runId, claimId: 'claim', executionSecret });

		expect(
			(await asUser.query(api.agentRuntime.getContext, { runId, executionSecret })).run
		).toMatchObject({ completionProvider: 'chatgpt', fallbackProviders: ['openai', 'spikonado'] });

		await expect(
			asUser.mutation(api.agentRuntime.fallBackToProvider, {
				runId,
				claimId: 'other-claim',
				executionSecret,
				completionProvider: 'openai'
			})
		).resolves.toBe(false);
		await expect(
			asUser.mutation(api.agentRuntime.fallBackToProvider, {
				runId,
				claimId: 'claim',
				executionSecret,
				completionProvider: 'spikonado'
			})
		).resolves.toBe(true);

		const context = await asUser.query(api.agentRuntime.getContext, { runId, executionSecret });

		expect(context.run.completionProvider).toBe('spikonado');
		expect(context.run.fallbackProviders).toBeUndefined();
		await expect(
			asUser.mutation(api.agentRuntime.fallBackToProvider, {
				runId,
				claimId: 'claim',
				executionSecret,
				completionProvider: 'openai'
			})
		).rejects.toThrow('Provider is not a remaining fallback for this run.');

		const thread = await t.run(async (ctx) => ctx.db.get('threadRecords', threadId));

		expect(thread?.reasoningStrippedThroughPartNumber).toBe(0);
	});

	it('reconciles a resubmission against the requested chain after a fallback', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'fallback-reconcile-secret';

		const request = {
			threadId,
			submissionId: 'fallback-reconcile',
			executionSecret,
			prompt: 'Resume me',
			completionProvider: 'openai' as const,
			fallbackProviders: ['spikonado' as const]
		};

		const { runId } = await insertQueuedRun(t, asUser, request);

		await asUser.mutation(api.agentRuntime.start, { runId, claimId: 'claim', executionSecret });
		await asUser.mutation(api.agentRuntime.fallBackToProvider, {
			runId,
			claimId: 'claim',
			executionSecret,
			completionProvider: 'spikonado'
		});

		await expect(insertQueuedRun(t, asUser, request)).resolves.toMatchObject({
			created: false,
			runId
		});
		await expect(insertQueuedRun(t, asUser, { ...request, fallbackProviders: [] })).rejects.toThrow(
			'Submission belongs to a different or incomplete run.'
		);
	});

	it('reports the provider preferences runners use for subagents', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'preferences-secret';

		await asUser.mutation(api.uiPreferences.setProviderOrder, {
			providerOrder: [
				{ provider: 'chatgpt', enabled: true },
				{ provider: 'spikonado', enabled: false },
				{ provider: 'openai', enabled: true }
			]
		});
		await asUser.mutation(api.uiPreferences.setRestrictSubagentsToProvider, { enabled: true });

		const { runId } = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'preferences-run',
			executionSecret,
			prompt: 'Delegate'
		});

		expect(
			(await asUser.query(api.agentRuntime.getContext, { runId, executionSecret }))
				.providerPreferences
		).toEqual({ enabledProviders: ['chatgpt', 'openai'], restrictSubagentsToProvider: true });
	});

	it('rejects a provider order that disables every provider', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);

		await expect(
			asUser.mutation(api.uiPreferences.setProviderOrder, {
				providerOrder: [
					{ provider: 'chatgpt', enabled: false },
					{ provider: 'spikonado', enabled: false },
					{ provider: 'openai', enabled: false }
				]
			})
		).rejects.toThrow('at least one enabled');
	});
});
