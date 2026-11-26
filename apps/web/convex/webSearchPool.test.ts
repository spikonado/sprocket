import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patchRunExecution } from '@convex/lib/runExecution';
import { api, internal } from '@convex/_generated/api';
import { fixtureWorkId, initConvexTest, seedStartedWebJob } from './test.setup';

beforeEach(() => vi.useFakeTimers());

afterEach(() => vi.useRealTimers());

describe('web search workpool fencing', () => {
	it(
		'ignores onComplete callbacks after the owning claim expires',
		{ timeout: 15_000 },
		async () => {
			const t = initConvexTest();

			const { runId, claimId, jobId } = await seedStartedWebJob(t, {
				executionSecret: 'webpool-secret',
				kind: 'web_search',
				payload: { query: 'sprocket' }
			});

			const stored = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
			expect(stored?.cloudWorkId).toEqual(expect.any(String));

			await t.run(async (ctx) => {
				await patchRunExecution(ctx, runId, { claimExpiresAt: Date.now() - 1 });
			});
			await t.mutation(internal.webSearchPool.completeWebSearch, {
				workId: stored!.cloudWorkId!,
				context: { jobId, runId, claimId },
				result: { kind: 'success', returnValue: { results: [{ url: 'https://example.com' }] } }
			});
			const after = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
			expect(after?.status).toBe('claimed');
		}
	);

	it('writes the tool result when the claim still owns the job', async () => {
		const t = initConvexTest();

		const { runId, claimId, jobId } = await seedStartedWebJob(t, {
			executionSecret: 'webpool-ok-secret',
			kind: 'web_search',
			payload: { query: 'sprocket' }
		});

		await t.mutation(internal.webSearchPool.completeWebSearch, {
			workId: fixtureWorkId('work-ok'),
			context: { jobId, runId, claimId },
			result: { kind: 'success', returnValue: { results: [{ url: 'https://example.com' }] } }
		});

		const after = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));

		expect(after?.status).toBe('completed');
		expect(after?.result).toMatchObject({ results: [{ url: 'https://example.com' }] });

		const snapshot = await t.query(api.executor.getJob, {
			runId,
			jobId,
			executionSecret: 'webpool-ok-secret'
		});

		expect(snapshot).toMatchObject({
			status: 'completed',
			part: {
				_id: expect.any(String),
				tool: {
					toolInvocationId: after?.toolInvocationId,
					status: 'completed',
					output: after?.result
				}
			}
		});
	});
});

describe('local scrape_url dispatch', () => {
	it('dispatches scrape_url locally without an execution-mode flag', async () => {
		const t = initConvexTest();

		const { jobId } = await seedStartedWebJob(t, {
			executionSecret: 'local-scrape-secret',
			kind: 'scrape_url',
			payload: { url: 'https://example.com/page' }
		});

		const stored = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(stored?.cloudWorkId).toBeUndefined();
		expect(stored?.status).toBe('claimed');
	});
});
