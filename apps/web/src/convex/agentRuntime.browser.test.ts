import { makeFunctionReference } from 'convex/server';
import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	toolTranscriptAssignment
} from './test.setup';

describe('browser screenshot results', () => {
	it('persists cached metadata from stored jobs', async () => {
		const result = {
			mediaType: 'image/png' as const,
			dataBase64: '',
			byteLength: 600_001,
			truncated: true
		};
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'screenshot-secret';
		const claimId = 'screenshot-claim';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'screenshot', executionSecret);
		await asUser.mutation(api.agentRuntime.start, { runId, claimId, executionSecret });
		const jobId = await t.run((ctx) =>
			ctx.db.insert('executorJobs', {
				threadId,
				runId,
				kind: 'browser_screenshot',
				toolInvocationId: 'test-invocation-browser-screenshot',
				payload: {},
				result,
				status: 'completed',
				enqueuedAt: 1,
				sequence: 0
			})
		);
		expect(await t.run((ctx) => ctx.db.get('executorJobs', jobId))).toMatchObject({
			status: 'completed',
			result
		});
	});
});

describe('retired browser clients', () => {
	it.each(['browser_act', 'browser_observe', 'browser_extract', 'browser_interact'] as const)(
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
					...toolTranscriptAssignment(runId, claimId),
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
					kind,
					toolInvocationId: 'test-invocation-browser-history',
					payload: { command: 'snapshot' },
					result: {
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
				kind,
				result: { text: 'Pay' }
			});
		}
	);
});
