import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest, insertQueuedRun, seedOwnedThread } from './test.setup';

describe('provider fallback', () => {
	it('moves a run to another provider and drops reasoning replay', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'fallback-secret';

		const request = {
			threadId,
			submissionId: 'fallback-run',
			executionSecret,
			prompt: 'Use the first provider that works',
			completionProvider: 'chatgpt' as const
		};

		const { runId } = await insertQueuedRun(t, asUser, request);

		await asUser.mutation(api.agentRuntime.start, { runId, claimId: 'claim', executionSecret });

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
		const thread = await t.run(async (ctx) => ctx.db.get('threadRecords', threadId));

		expect(context.run.completionProvider).toBe('spikonado');
		expect(thread?.completionProvider).toBe('spikonado');
		expect(thread?.reasoningStrippedThroughPartNumber).toBe(0);
		await expect(insertQueuedRun(t, asUser, request)).resolves.toMatchObject({
			created: false,
			runId
		});
	});

	it('reports the preferences runners read', async () => {
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
		await asUser.mutation(api.uiPreferences.setShareConversationContent, { enabled: false });

		const { runId } = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'preferences-run',
			executionSecret,
			prompt: 'Delegate'
		});

		const context = await asUser.query(api.agentRuntime.getContext, { runId, executionSecret });

		expect(context.providerPreferences).toEqual({
			enabledProviders: ['chatgpt', 'openai'],
			restrictSubagentsToProvider: true
		});
		expect(context.shareConversationContent).toBe(false);
	});
});
