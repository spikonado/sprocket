import { makeFunctionReference } from 'convex/server';
import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

describe('retired browser clients', () => {
	it.each(['browser_act', 'browser_observe', 'browser_extract'])(
		'rejects new %s jobs while preserving stored history',
		async (kind) => {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t);
			const executionSecret = 'browser-retired-secret';
			const claimId = 'browser-claim';
			const { runId } = await createQueuedRun(t, asUser, threadId, 'sub', executionSecret);
			await asUser.mutation(api.agentRuntime.start, { runId, claimId, executionSecret });

			await expect(
				asUser.mutation(makeFunctionReference<'mutation'>('agentRuntime:beginToolJob'), {
					runId,
					claimId,
					executionSecret,
					kind,
					payload: {}
				})
			).rejects.toThrow();
			expect(await t.run((ctx) => ctx.db.query('executorJobs').collect())).toEqual([]);

			const jobId = await t.run((ctx) =>
				ctx.db.insert('executorJobs', {
					threadId,
					runId,
					kind: 'browser_observe',
					payload: { instruction: 'Find Pay' },
					result: {
						actions: [{ selector: '#pay', description: 'Pay' }],
						text: 'Pay',
						truncated: false
					},
					status: 'completed',
					hidden: false,
					enqueuedAt: 1,
					sequence: 0
				})
			);
			expect(await t.run((ctx) => ctx.db.get('executorJobs', jobId))).toMatchObject({
				kind: 'browser_observe',
				result: { actions: [{ selector: '#pay', description: 'Pay' }] }
			});
			await expect(
				asUser.mutation(api.agentRuntime.beginToolJob, {
					runId,
					claimId,
					executionSecret,
					kind: 'browser_interact',
					payload: { command: 'snapshot' }
				})
			).resolves.toMatchObject({ sequence: 1 });
		}
	);
});
