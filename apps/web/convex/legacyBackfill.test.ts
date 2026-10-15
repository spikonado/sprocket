import { describe, expect, it } from 'vitest';
import { internal } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';

const oneBatch = { cursor: null, dryRun: false, oneBatchOnly: true } as const;

describe('terminal job backfill migration', () => {
	it('reconciles historical terminal tool results before releasing follow-ups', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);

		const run = await t.run((ctx) =>
			ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', threadId))
				.first()
		);

		const jobId = await t.run((ctx) =>
			ctx.db.insert('executorJobs', {
				threadId,
				runId: run!._id,
				kind: 'exec_command',
				payload: { cmd: 'true' },
				status: 'claimed',
				enqueuedAt: Date.now(),
				sequence: 0
			})
		);

		await t.mutation(internal.migrations.reconcileLegacyTerminalJobs, oneBatch);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query('runExecutionStates')
					.withIndex('by_runId', (q) => q.eq('runId', run!._id))
					.unique()
			)
		).toMatchObject({ terminalJobsReconciled: true });
		expect(await t.run((ctx) => ctx.db.get('executorJobs', jobId))).toMatchObject({
			status: 'cancelled'
		});
		expect(await t.run((ctx) => ctx.db.query('threadTranscriptParts').first())).toMatchObject({
			kind: 'tool',
			tool: { status: 'cancelled' }
		});
	});
});
