import { makeFunctionReference } from 'convex/server';
import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

describe('browser screenshot results', () => {
	it.each([
		{
			outputType: 'image' as const,
			path: '/cache/parse_file/screenshot.png',
			mediaType: 'image/png' as const,
			byteSize: 123,
			width: 10,
			height: 20
		},
		{ mediaType: 'image/png' as const, dataBase64: '', byteLength: 600_001, truncated: true },
		{ mediaType: 'image/png' as const, dataBase64: '', byteLength: 123, truncated: false }
	])('persists cached and historical metadata: %j', async (result) => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'screenshot-secret';
		const claimId = 'screenshot-claim';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'screenshot', executionSecret);
		await asUser.mutation(api.agentRuntime.start, { runId, claimId, executionSecret });
		const { jobId } = await asUser.mutation(api.agentRuntime.beginToolJob, {
			runId,
			claimId,
			executionSecret,
			kind: 'browser_screenshot',
			payload: {}
		});
		await expect(
			asUser.mutation(api.executor.complete, { runId, claimId, executionSecret, jobId, result })
		).resolves.toBe(true);
		expect(await t.run((ctx) => ctx.db.get('executorJobs', jobId))).toMatchObject({
			status: 'completed',
			result
		});
	});
});

describe('retired browser clients', () => {
	it.each(['browser_interact', 'browser_screenshot'] as const)(
		'rejects disable_saving on new %s jobs but preserves recorded calls',
		async (kind) => {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t);
			const executionSecret = 'saving-secret';
			const claimId = 'saving-claim';
			const { runId } = await createQueuedRun(t, asUser, threadId, 'sub', executionSecret);
			await asUser.mutation(api.agentRuntime.start, { runId, claimId, executionSecret });
			const payload =
				kind === 'browser_interact'
					? { command: 'get url', disable_saving: true }
					: { disable_saving: true };
			await expect(
				asUser.mutation(makeFunctionReference<'mutation'>('agentRuntime:beginToolJob'), {
					runId,
					claimId,
					executionSecret,
					kind,
					payload
				})
			).rejects.toThrow();
			const jobId = await t.run((ctx) =>
				ctx.db.insert('executorJobs', {
					threadId,
					runId,
					kind,
					payload,
					status: 'completed',
					hidden: false,
					enqueuedAt: 1,
					sequence: 0
				})
			);
			expect((await t.run((ctx) => ctx.db.get('executorJobs', jobId)))?.payload).toEqual(payload);
		}
	);

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
