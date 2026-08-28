import { describe, expect, it } from 'vitest';
import type { WorkId } from '@convex-dev/workpool';
import { api, internal } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

describe('web tool workpool fencing', () => {
	it('ignores onComplete callbacks after a claim takeover', { timeout: 15_000 }, async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'webpool-secret';
		const created = await createQueuedRun(
			t,
			asUser,
			threadId,
			'webpool-run',
			executionSecret,
			'Search'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId: created.runId,
			claimId: 'claim-a',
			executionSecret
		});
		const job = await asUser.mutation(api.agentRuntime.beginToolJob, {
			runId: created.runId,
			claimId: 'claim-a',
			kind: 'web_search',
			payload: { query: 'sprocket' },
			executionSecret
		});
		const stored = await t.run(async (ctx) => ctx.db.get('executorJobs', job.jobId));
		expect(stored?.cloudWorkId).toEqual(expect.any(String));

		await t.run(async (ctx) => {
			await ctx.db.patch('runs', created.runId, { claimExpiresAt: Date.now() - 1 });
		});
		await asUser.mutation(api.agentRuntime.start, {
			runId: created.runId,
			claimId: 'claim-b',
			executionSecret
		});

		await t.mutation(internal.webToolPool.completeWebTool, {
			// SAFETY: Workpool onComplete only uses workId for its own bookkeeping.
			workId: (stored?.cloudWorkId ?? 'work') as WorkId,
			context: { jobId: job.jobId, runId: created.runId, claimId: 'claim-a' },
			result: { kind: 'success', returnValue: { results: [{ url: 'https://example.com' }] } }
		});
		const after = await t.run(async (ctx) => ctx.db.get('executorJobs', job.jobId));
		expect(after?.status).toBe('cancelled');
	});

	it('writes the tool result when the claim still owns the job', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'webpool-ok-secret';
		const created = await createQueuedRun(
			t,
			asUser,
			threadId,
			'webpool-ok',
			executionSecret,
			'Search'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId: created.runId,
			claimId: 'claim-a',
			executionSecret
		});
		const job = await asUser.mutation(api.agentRuntime.beginToolJob, {
			runId: created.runId,
			claimId: 'claim-a',
			kind: 'web_search',
			payload: { query: 'sprocket' },
			executionSecret
		});
		await t.mutation(internal.webToolPool.completeWebTool, {
			// SAFETY: completeWebTool ignores workId and fences on job/claim state.
			workId: 'work-ok' as WorkId,
			context: { jobId: job.jobId, runId: created.runId, claimId: 'claim-a' },
			result: { kind: 'success', returnValue: { results: [{ url: 'https://example.com' }] } }
		});
		const after = await t.run(async (ctx) => ctx.db.get('executorJobs', job.jobId));
		expect(after?.status).toBe('completed');
		expect(after?.result).toMatchObject({ results: [{ url: 'https://example.com' }] });
	});
});
