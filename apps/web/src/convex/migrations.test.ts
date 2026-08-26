import { describe, expect, it } from 'vitest';
import { internal } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';

describe('migrations.rewriteDroppedMaxReasoning', () => {
	it('clamps stored max efforts onto model defaults and leaves valid rows alone', async () => {
		const t = initConvexTest();
		const { subject, projectId } = await seedOwnedThread(t);

		await t.run(async (ctx) => {
			const threadId = await ctx.db.insert('threadRecords', {
				userId: subject,
				submissionId: 'legacy-thread',
				projectId,
				selectedModel: 'stealth/ox-alpha',
				reasoningEffort: 'max',
				serviceTier: 'standard',
				lastMessageAt: 1
			});
			await ctx.db.insert('runs', {
				threadId,
				userId: subject,
				submissionId: 'legacy-run',
				projectId,
				status: 'completed',
				executionSecretHash: 'hash',
				completionAttemptSeq: 0,
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'max',
				serviceTier: 'standard',
				startedAt: 1
			});
			await ctx.db.insert('runs', {
				threadId,
				userId: subject,
				submissionId: 'legacy-open-model-run',
				projectId,
				status: 'completed',
				executionSecretHash: 'hash',
				completionAttemptSeq: 0,
				selectedModel: 'kimi-k3',
				reasoningEffort: 'max',
				serviceTier: 'standard',
				startedAt: 2
			});
		});

		const result = await t.run(async (ctx) =>
			ctx.runMutation(internal.migrations.rewriteDroppedMaxReasoning, {})
		);

		await t.run(async (ctx) => {
			const threads = await ctx.db.query('threadRecords').collect();
			const oxAlphaThread = threads.find((row) => row.selectedModel === 'stealth/ox-alpha');
			expect(oxAlphaThread?.reasoningEffort).toBe('high');
			const runs = await ctx.db.query('runs').collect();
			const solRun = runs.find((row) => row.submissionId === 'legacy-run');
			expect(solRun?.reasoningEffort).toBe('medium');
			const kimiRun = runs.find((row) => row.submissionId === 'legacy-open-model-run');
			expect(kimiRun?.reasoningEffort).toBe('max');
		});

		expect(result.rewritten).toBe(2);
		expect(result.scanned).toBeGreaterThanOrEqual(3);

		const rerun = await t.run(async (ctx) =>
			ctx.runMutation(internal.migrations.rewriteDroppedMaxReasoning, {})
		);
		expect(rerun.rewritten).toBe(0);
	});
});
