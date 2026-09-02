import { describe, expect, it } from 'vitest';
import { internal } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';

describe('clearResponseMessageParts', () => {
	it('clears leftover response payloads and leaves prompts alone', async () => {
		const t = initConvexTest();
		const { subject, threadId } = await seedOwnedThread(t);
		const ids = await t.run(async (ctx) => {
			const runId = await ctx.db.insert('runs', {
				threadId,
				userId: subject,
				submissionId: 'clear-response-parts',
				status: 'completed',
				executionSecretHash: 'hash',
				completionAttemptSeq: 0,
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				startedAt: 1,
				completedAt: 2
			});
			const promptId = await ctx.db.insert('threadMessages', {
				threadId,
				runId,
				userId: subject,
				type: 'prompt',
				text: 'Keep this',
				parts: []
			});
			const responseA = await ctx.db.insert('threadMessages', {
				threadId,
				runId,
				userId: subject,
				type: 'response',
				text: 'Drop this',
				parts: [{ type: 'text', id: 't1', text: 'Drop this' }]
			});
			const responseB = await ctx.db.insert('threadMessages', {
				threadId,
				runId,
				userId: subject,
				type: 'response',
				text: 'Drop that',
				parts: [{ type: 'text', id: 't2', text: 'Drop that' }]
			});
			return { promptId, responseA, responseB };
		});

		await t.mutation(internal.migrations.clearResponseMessageParts, {});
		await t.finishAllScheduledFunctions(() => {});

		const { prompt, responseA, responseB } = await t.run(async (ctx) => ({
			prompt: await ctx.db.get('threadMessages', ids.promptId),
			responseA: await ctx.db.get('threadMessages', ids.responseA),
			responseB: await ctx.db.get('threadMessages', ids.responseB)
		}));
		expect(prompt).toMatchObject({ text: 'Keep this', parts: [] });
		expect(responseA).toMatchObject({ text: '', parts: [] });
		expect(responseB).toMatchObject({ text: '', parts: [] });
	});
});
